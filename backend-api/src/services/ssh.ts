import { Client, ClientChannel } from 'ssh2';
import { getServerCreds, ServerCreds } from './devops.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type SshResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type CreateServerUserOptions = {
  username: string;
  password: string;
  publicKey?: string;
  installSshKey?: boolean;
  nopasswdSudo?: boolean;
  sudoPasswordOverride?: string;
};

export type CreateServerUserResult = {
  username: string;
  sudoGroup: string;
  sshKeyInstalled: boolean;
  nopasswdSudo: boolean;
};

// ── Dangerous command check ─────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  /rm\s+(-\w*r\w*f\w*\s+|.*--no-preserve-root)/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /\bshutdown\b/i,
  /\binit\s+[06]\b/i,
  />\s*\/dev\/sda/i,
  /\bchmod\s+(-R\s+)?000\s+\//i,
  /\bchown\s+(-R\s+)?\w+\s+\//i,
];

const isDangerous = (cmd: string): boolean => {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd.trim()));
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const buildSshConfig = (creds: ServerCreds, timeoutMs: number) => {
  const config: any = {
    host: creds.host,
    port: creds.port,
    username: creds.username,
    readyTimeout: timeoutMs,
  };

  if (creds.privateKey) {
    config.privateKey = creds.privateKey;
  } else if (creds.password) {
    config.password = creds.password;
  }

  return config;
};

// ── Exec ────────────────────────────────────────────────────────────────────

const SSH_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1 MB

/**
 * Execute a command on a remote server via SSH.
 * Credentials are decrypted in-memory — never logged or exposed.
 */
export const execSshCommand = (
  userId: number,
  serverId: number,
  command: string,
  options?: { sudoPasswordOverride?: string },
): Promise<SshResult> => {
  return new Promise(async (resolve, reject) => {
    // Check dangerous commands
    if (isDangerous(command)) {
      return reject(new Error('command_blocked_dangerous'));
    }

    const creds = getServerCreds(userId, serverId);
    if (!creds) {
      return reject(new Error('server_not_found'));
    }

    if (!creds.password && !creds.privateKey) {
      return reject(new Error('server_no_credentials'));
    }

    const client = new Client();
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const cleanup = () => {
      resolved = true;
      client.end();
    };

    const fail = (err: Error) => {
      if (!resolved) { cleanup(); reject(err); }
    };

    const done = (exitCode: number | null) => {
      if (!resolved) {
        cleanup();
        resolve({ stdout, stderr, exitCode });
      }
    };

    // Timeout guard
    const timer = setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error('ssh_timeout'));
      }
    }, SSH_TIMEOUT_MS);

    client.on('ready', () => {
      clearTimeout(timer);

      // If command uses sudo and we have a sudo password, use sudo -S and write password to stdin
      let execCommand = command;
      const sudoPassword = options?.sudoPasswordOverride || creds.sudoPassword;
      const needsSudoPassword = /\bsudo\b/.test(command) && sudoPassword;
      if (needsSudoPassword) {
        execCommand = `sudo -S ${command.replace(/^\s*sudo\s+/, '')}`;
      }

      client.exec(execCommand, (err: Error | undefined, stream: ClientChannel) => {
        if (err) { fail(err); return; }

        // Write sudo password directly to stdin stream (not visible in process list)
        if (needsSudoPassword) {
          stream.write(sudoPassword! + '\n');
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
          if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER);
        });

        stream.on('close', (code: number | null) => {
          done(code);
        });

        stream.on('error', (err: Error) => { fail(err); });
      });
    });

    client.on('error', (err: Error) => {
      clearTimeout(timer);
      fail(err);
    });

    client.connect(buildSshConfig(creds, SSH_TIMEOUT_MS));
  });
};

export const createServerUser = (
  userId: number,
  serverId: number,
  options: CreateServerUserOptions,
): Promise<CreateServerUserResult> => {
  return new Promise((resolve, reject) => {
    const username = options.username.trim();
    const password = options.password;

    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      return reject(new Error('invalid_username'));
    }
    if (password.length < 8 || password.length > 128 || /[\r\n]/.test(password)) {
      return reject(new Error('invalid_password'));
    }

    const creds = getServerCreds(userId, serverId);
    if (!creds) return reject(new Error('server_not_found'));
    if (!creds.password && !creds.privateKey) return reject(new Error('server_no_credentials'));

    const client = new Client();
    let resolved = false;
    let sudoMode: 'root' | 'nopasswd' | 'password' = 'password';
    let sudoGroup = 'sudo';

    const cleanup = () => {
      resolved = true;
      client.end();
    };

    const fail = (err: Error) => {
      if (!resolved) { cleanup(); reject(err); }
    };

    const done = (result: CreateServerUserResult) => {
      if (!resolved) { cleanup(); resolve(result); }
    };

    const run = (command: string, input?: string): Promise<SshResult> => {
      return new Promise((runResolve, runReject) => {
        let stdout = '';
        let stderr = '';

        client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
          if (err) return runReject(err);

          if (input !== undefined) {
            stream.write(input);
            stream.end();
          }

          stream.on('data', (data: Buffer) => {
            stdout += data.toString();
            if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
          });
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
            if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER);
          });
          stream.on('close', (code: number | null) => runResolve({ stdout, stderr, exitCode: code }));
          stream.on('error', (streamErr: Error) => runReject(streamErr));
        });
      });
    };

    const sudoCommand = (command: string): string => {
      if (sudoMode === 'root') return command;
      if (sudoMode === 'nopasswd') return `sudo -n ${command}`;
      return `sudo -S -p '' ${command}`;
    };

    const sudoInput = (payload?: string): string | undefined => {
      if (sudoMode === 'password') return `${options.sudoPasswordOverride || creds.sudoPassword || ''}\n${payload || ''}`;
      return payload;
    };

    const runSudo = (command: string, payload?: string) => run(sudoCommand(command), sudoInput(payload));

    const timer = setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error('ssh_timeout'));
      }
    }, SSH_TIMEOUT_MS);

    client.on('ready', async () => {
      clearTimeout(timer);

      try {
        if (creds.username === 'root') {
          sudoMode = 'root';
        } else {
          const nopasswdCheck = await run('sudo -n true');
          if (nopasswdCheck.exitCode === 0) {
            sudoMode = 'nopasswd';
          } else if (options.sudoPasswordOverride || creds.sudoPassword) {
            const passwordCheck = await run('sudo -S -p \'\' true', `${options.sudoPasswordOverride || creds.sudoPassword}\n`);
            if (passwordCheck.exitCode !== 0) throw new Error('sudo_auth_failed');
            sudoMode = 'password';
          } else {
            throw new Error('sudo_password_required');
          }
        }

        const exists = await run(`id -u ${shellQuote(username)}`);
        if (exists.exitCode === 0) throw new Error('user_already_exists');

        const groupResult = await run('getent group sudo >/dev/null 2>&1 && printf sudo || printf wheel');
        sudoGroup = groupResult.stdout.trim() === 'wheel' ? 'wheel' : 'sudo';

        let result = await runSudo(`useradd -m -s /bin/bash -- ${shellQuote(username)}`);
        if (result.exitCode !== 0) throw new Error(`useradd_failed: ${result.stderr || result.stdout}`);

        result = await runSudo('chpasswd', `${username}:${password}\n`);
        if (result.exitCode !== 0) throw new Error(`chpasswd_failed: ${result.stderr || result.stdout}`);

        result = await runSudo(`usermod -aG ${shellQuote(sudoGroup)} -- ${shellQuote(username)}`);
        if (result.exitCode !== 0) throw new Error(`usermod_failed: ${result.stderr || result.stdout}`);

        const nopasswdSudo = options.nopasswdSudo !== false;
        if (nopasswdSudo) {
          const sudoersLine = `${username} ALL=(ALL) NOPASSWD:ALL`;
          const sudoersPath = `/etc/sudoers.d/${username}`;
          result = await runSudo(`sh -c ${shellQuote(`printf '%s\\n' ${shellQuote(sudoersLine)} > ${shellQuote(sudoersPath)} && chmod 0440 ${shellQuote(sudoersPath)}`)}`);
          if (result.exitCode !== 0) throw new Error(`sudoers_failed: ${result.stderr || result.stdout}`);
        }

        const shouldInstallKey = options.installSshKey !== false && !!options.publicKey;
        if (shouldInstallKey && options.publicKey) {
          const escapedKey = options.publicKey.replace(/'/g, `'\\''`);
          const home = `/home/${username}`;
          const script = [
            `mkdir -p ${shellQuote(`${home}/.ssh`)}`,
            `printf '%s\\n' '${escapedKey}' >> ${shellQuote(`${home}/.ssh/authorized_keys`)}`,
            `sort -u ${shellQuote(`${home}/.ssh/authorized_keys`)} -o ${shellQuote(`${home}/.ssh/authorized_keys`)}`,
            `chmod 700 ${shellQuote(`${home}/.ssh`)}`,
            `chmod 600 ${shellQuote(`${home}/.ssh/authorized_keys`)}`,
            `chown -R ${shellQuote(username)}:${shellQuote(username)} ${shellQuote(`${home}/.ssh`)}`,
          ].join(' && ');
          result = await runSudo(`sh -c ${shellQuote(script)}`);
          if (result.exitCode !== 0) throw new Error(`install_key_failed: ${result.stderr || result.stdout}`);
        }

        done({
          username,
          sudoGroup,
          sshKeyInstalled: shouldInstallKey,
          nopasswdSudo,
        });
      } catch (err: any) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    client.on('error', (err: Error) => {
      clearTimeout(timer);
      fail(err);
    });

    client.connect(buildSshConfig(creds, SSH_TIMEOUT_MS));
  });
};

/**
 * Test SSH connection without running a command.
 * Returns true if connection succeeds, error message if not.
 */
export const testSshConnection = (
  userId: number,
  serverId: number,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  return new Promise((resolve) => {
    const creds = getServerCreds(userId, serverId);
    if (!creds) {
      return resolve({ ok: false, error: 'server_not_found' });
    }

    const client = new Client();

    const timer = setTimeout(() => {
      client.end();
      resolve({ ok: false, error: 'connection_timeout' });
    }, 10_000);

    client.on('ready', () => {
      clearTimeout(timer);
      client.end();
      resolve({ ok: true });
    });

    client.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });

    const config: any = {
      host: creds.host,
      port: creds.port,
      username: creds.username,
      readyTimeout: 10_000,
    };

    if (creds.privateKey) {
      config.privateKey = creds.privateKey;
    } else if (creds.password) {
      config.password = creds.password;
    }

    client.connect(config);
  });
};
