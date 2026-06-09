import { Client, ClientChannel } from 'ssh2';
import { getServerCreds, ServerCreds } from './devops.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type SshResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
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
      const needsSudoPassword = /\bsudo\b/.test(command) && creds.sudoPassword;
      if (needsSudoPassword) {
        execCommand = `sudo -S ${command.replace(/^\s*sudo\s+/, '')}`;
      }

      client.exec(execCommand, (err: Error | undefined, stream: ClientChannel) => {
        if (err) { fail(err); return; }

        // Write sudo password directly to stdin stream (not visible in process list)
        if (needsSudoPassword) {
          stream.write(creds.sudoPassword! + '\n');
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

    // Connect config
    const config: any = {
      host: creds.host,
      port: creds.port,
      username: creds.username,
      readyTimeout: SSH_TIMEOUT_MS,
    };

    if (creds.privateKey) {
      config.privateKey = creds.privateKey;
    } else if (creds.password) {
      config.password = creds.password;
    }

    client.connect(config);
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
