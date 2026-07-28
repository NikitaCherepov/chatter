import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SEVERITY_ORDER = {
  critical: 4,
  high: 3,
  medium: 2,
  review: 1,
  info: 0,
};

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const HISTORY_BATCH_SIZE = 200;

const args = process.argv.slice(2);
const readOption = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const mode = readOption('--mode', 'all');
const reportPathArg = readOption('--report', '.secret-scan-report.json');
const failOn = readOption('--fail-on', 'none');
const maxFileBytesRaw = Number(readOption('--max-file-bytes', String(DEFAULT_MAX_FILE_BYTES)));
const maxFileBytes = Number.isFinite(maxFileBytesRaw) && maxFileBytesRaw > 0
  ? Math.floor(maxFileBytesRaw)
  : DEFAULT_MAX_FILE_BYTES;

if (args.includes('--help')) {
  console.log(`Usage: node scripts/security/scan-secrets.mjs [options]

Options:
  --mode current|history|all   What to scan (default: all)
  --report <path>              Redacted JSON report path
  --max-file-bytes <bytes>     Skip larger blobs (default: 5242880)
  --fail-on none|medium|high|critical
                               Exit with code 2 at or above this severity

The report never contains matched values or source snippets.`);
  process.exit(0);
}

if (!['current', 'history', 'all'].includes(mode)) {
  throw new Error(`Unsupported --mode: ${mode}`);
}
if (!['none', 'medium', 'high', 'critical'].includes(failOn)) {
  throw new Error(`Unsupported --fail-on: ${failOn}`);
}

const findRepositoryRoot = (start) => {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Git repository root not found');
    current = parent;
  }
};

const repositoryRoot = findRepositoryRoot(process.cwd());
const repositoryRootForGit = repositoryRoot.replaceAll('\\', '/');
const reportPath = path.resolve(repositoryRoot, reportPathArg);

const runGit = (gitArgs, options = {}) => {
  const result = spawnSync(
    'git',
    ['-c', `safe.directory=${repositoryRootForGit}`, ...gitArgs],
    {
      cwd: repositoryRoot,
      encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
      input: options.input,
      maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
      windowsHide: true,
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr || '');
    throw new Error(`git ${gitArgs[0]} failed: ${stderr.trim()}`);
  }
  return result.stdout;
};

const placeholderFragments = [
  'process.env',
  'import.meta.env',
  '${',
  '<your',
  '<token',
  '<secret',
  'your_',
  'your-',
  'example',
  'placeholder',
  'changeme',
  'change_me',
  'replace_me',
  'removed',
  'redacted',
  'dummy',
  'localhost',
];

const looksLikePlaceholder = (value) => {
  const normalized = value.toLowerCase();
  if (placeholderFragments.some((fragment) => normalized.includes(fragment))) return true;
  return /^[x*_.-]+$/i.test(value);
};

const shannonEntropy = (value) => {
  if (!value) return 0;
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
};

const looksLikeSecretValue = (value) => {
  if (looksLikePlaceholder(value) || value.length < 16) return false;
  if (/^(?:true|false|null|undefined|none|approved|pending|bearer)$/i.test(value)) return false;
  if (/^(?:process|import\.meta|req|request|res|response|ctx|user|config|localStorage|sessionStorage)\b/i.test(value)) {
    return false;
  }

  const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
  if (isIdentifier) {
    const hasLower = /[a-z]/.test(value);
    const hasUpper = /[A-Z]/.test(value);
    const hasDigit = /\d/.test(value);
    if (!(hasLower && hasUpper && hasDigit)) return false;
  }

  if (/^[a-z]+(?:_[a-z]+)+$/.test(value)) return false;
  return shannonEntropy(value) >= 3.4;
};

const isValidIpv4 = (value) => {
  const octets = value.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) => (
    Number.isInteger(octet) && octet >= 0 && octet <= 255
  ));
};

const isUninterestingIpv4 = (value) => (
  value === '0.0.0.0'
  || value === '127.0.0.1'
  || value === '255.255.255.255'
  || value.startsWith('192.0.2.')
  || value.startsWith('198.51.100.')
  || value.startsWith('203.0.113.')
);

const isGenericHomeName = (value) => [
  'user',
  'users',
  'username',
  'yourname',
  'example',
  'runner',
].includes(value.toLowerCase());

const rules = [
  {
    id: 'telegram_bot_token',
    severity: 'critical',
    regex: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
    binarySafe: true,
  },
  {
    id: 'openai_or_anthropic_key',
    severity: 'critical',
    regex: /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    binarySafe: true,
  },
  {
    id: 'github_token',
    severity: 'critical',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
    binarySafe: true,
  },
  {
    id: 'aws_access_key',
    severity: 'critical',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    binarySafe: true,
  },
  {
    id: 'google_api_key',
    severity: 'critical',
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    binarySafe: true,
  },
  {
    id: 'pinecone_api_key',
    severity: 'critical',
    regex: /\bpcsk_[A-Za-z0-9_-]{20,}\b/g,
    binarySafe: true,
  },
  {
    id: 'tavily_api_key',
    severity: 'critical',
    regex: /\btvly-[A-Za-z0-9_-]{20,}\b/g,
    binarySafe: true,
  },
  {
    id: 'slack_token',
    severity: 'critical',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    binarySafe: true,
  },
  {
    id: 'stripe_live_key',
    severity: 'critical',
    regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
    binarySafe: true,
  },
  {
    id: 'jwt',
    severity: 'high',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    binarySafe: true,
  },
  {
    id: 'credentialed_connection_url',
    severity: 'high',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi,
    binarySafe: true,
  },
  {
    id: 'authorization_bearer_literal',
    severity: 'high',
    regex: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/gi,
    valueGroup: 1,
    binarySafe: true,
    filter: (value) => looksLikeSecretValue(value),
  },
  {
    id: 'hardcoded_credential_assignment',
    severity: 'high',
    regex: /(?:^|[^A-Za-z0-9])([A-Za-z0-9_]*(?:api[_-]?key|access[_-]?key|client[_-]?secret|secret|token|password|passwd|pwd|encryption[_-]?key|private[_-]?key))["']?\s*[:=]\s*(["'`]?)([^\s"'`,;})\]]{8,})/gi,
    valueGroup: 3,
    binarySafe: true,
    filter: (value, match, context) => {
      if (/(?:^|\/)i18n\/locales\/[^/]+\/translation\.json$/i.test(context.file.replaceAll('\\', '/'))) {
        return false;
      }
      const quoted = Boolean(match[2]);
      const configLikeFile = /\.(?:env|ya?ml|toml|ini|conf|config)$/i.test(context.file);
      return (quoted || configLikeFile) && looksLikeSecretValue(value);
    },
  },
  {
    id: 'ipv4_address',
    severity: 'review',
    regex: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    filter: (value, _match, context) => (
      isValidIpv4(value)
      && !isUninterestingIpv4(value)
      && !/placeholder|example/i.test(context.lineText)
    ),
    skipDependencyLocks: true,
  },
  {
    id: 'email_address',
    severity: 'review',
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    filter: (value) => !looksLikePlaceholder(value),
    classify: (value) => {
      const [localPart, domain = ''] = value.toLowerCase().split('@');
      const placeholderNames = ['test', 'user', 'sample', 'demo', 'email'];
      const publicProviders = ['gmail.com', 'outlook.com', 'hotmail.com', 'yandex.ru', 'mail.ru'];
      return {
        localPart: placeholderNames.includes(localPart) ? 'placeholder-like' : 'name-like-or-custom',
        domain: /^(?:example\.(?:com|org|net)|example\.test)$/i.test(domain)
          ? 'documentation-domain'
          : publicProviders.includes(domain)
            ? 'public-provider'
            : 'custom-domain',
      };
    },
    skipDependencyLocks: true,
  },
  {
    id: 'windows_user_path',
    severity: 'review',
    regex: /\b[A-Za-z]:\\Users\\([^\\/\s"'`]+)/gi,
    valueGroup: 1,
    filter: (value) => !isGenericHomeName(value),
  },
  {
    id: 'unix_home_path',
    severity: 'review',
    regex: /\/home\/([^/\s"'`]+)/g,
    valueGroup: 1,
    filter: (value) => !isGenericHomeName(value),
  },
];

const documentRules = [
  {
    id: 'private_key',
    severity: 'critical',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
];

const isDependencyLock = (file) => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(
  file.replaceAll('\\', '/')
);

const sensitivePathRule = (filePath) => {
  const normalized = filePath.replaceAll('\\', '/');
  const baseName = path.posix.basename(normalized).toLowerCase();

  if (/^\.env(?:\..+)?$/i.test(baseName) && !/\.example$/i.test(baseName)) {
    return { severity: 'high', reason: 'environment_file' };
  }
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|replacements\.txt)$/i.test(baseName)) {
    return { severity: 'high', reason: 'secret_material_file' };
  }
  if (/\.(?:pem|key|p12|pfx|kdbx|sqlite|sqlite3|db|bak|backup)$/i.test(baseName)) {
    return { severity: 'high', reason: 'sensitive_data_file' };
  }
  if (/\.(?:asar|zip|7z|rar|tar|tgz|gz)$/i.test(baseName)) {
    return { severity: 'medium', reason: 'generated_or_archive_file' };
  }
  return null;
};

const findings = [];
const findingKeys = new Set();
const stats = {
  currentFilesScanned: 0,
  historyBlobsScanned: 0,
  binaryFilesScanned: 0,
  skippedLargeObjects: 0,
  skippedBinaryObjects: 0,
  reachableObjects: 0,
};

const addFinding = ({
  scope,
  rule,
  severity,
  file,
  line = null,
  value = '',
  blob = null,
  state = null,
  classification = null,
}) => {
  const internalKey = [scope, rule, file, line ?? '', value, blob ?? '', state ?? ''].join('\0');
  if (findingKeys.has(internalKey)) return;
  findingKeys.add(internalKey);

  findings.push({
    scope,
    rule,
    severity,
    file: file.replaceAll('\\', '/'),
    line,
    matchLength: value ? value.length : null,
    blob,
    state,
    classification,
  });
};

const inspectPath = (scope, file, blob = null, state = null) => {
  const riskyPath = sensitivePathRule(file);
  if (!riskyPath) return;
  addFinding({
    scope,
    rule: riskyPath.reason,
    severity: riskyPath.severity,
    file,
    blob,
    state,
  });
};

const isProbablyBinary = (buffer) => buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);

const scanBuffer = ({ scope, file, buffer, blob = null }) => {
  const binary = isProbablyBinary(buffer);
  if (binary) stats.binaryFilesScanned += 1;

  const text = buffer.toString(binary ? 'latin1' : 'utf8');
  const lines = text.split(/\r?\n/);

  for (const rule of documentRules) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    for (const match of text.matchAll(regex)) {
      const line = binary ? null : text.slice(0, match.index).split(/\r?\n/).length;
      addFinding({
        scope,
        rule: rule.id,
        severity: rule.severity,
        file,
        line,
        value: match[0],
        blob,
      });
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const rule of rules) {
      if (binary && !rule.binarySafe) continue;
      if (rule.skipDependencyLocks && isDependencyLock(file)) continue;
      const regex = new RegExp(rule.regex.source, rule.regex.flags);
      for (const match of line.matchAll(regex)) {
        const value = match[rule.valueGroup ?? 0] || match[0];
        if (!value || looksLikePlaceholder(value)) continue;
        if (rule.filter && !rule.filter(value, match, {
          file,
          line: lineIndex + 1,
          lineText: line,
          binary,
        })) continue;

        addFinding({
          scope,
          rule: rule.id,
          severity: rule.severity,
          file,
          line: binary ? null : lineIndex + 1,
          value,
          blob,
          classification: rule.classify ? rule.classify(value) : null,
        });
      }
    }
  }
};

const scanCurrentTree = () => {
  const trackedRaw = runGit(['ls-files', '-z']);
  const trackedFiles = trackedRaw.split('\0').filter(Boolean);

  for (const file of trackedFiles) {
    inspectPath('current', file);
    const absolutePath = path.join(repositoryRoot, file);
    if (!fs.existsSync(absolutePath)) continue;
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) continue;
    if (stat.size > maxFileBytes) {
      stats.skippedLargeObjects += 1;
      continue;
    }
    scanBuffer({ scope: 'current', file, buffer: fs.readFileSync(absolutePath) });
    stats.currentFilesScanned += 1;
  }

  const statusRaw = runGit(['status', '--porcelain=v1', '--ignored', '-z', '--untracked-files=normal']);
  const statusEntries = statusRaw.split('\0').filter(Boolean);
  for (const entry of statusEntries) {
    if (entry.length < 4) continue;
    const state = entry.slice(0, 2);
    const file = entry.slice(3);
    const riskyPath = sensitivePathRule(file);
    if (!riskyPath) continue;
    addFinding({
      scope: 'worktree-only',
      rule: state === '!!' ? 'ignored_sensitive_path' : 'untracked_sensitive_path',
      severity: 'info',
      file,
      state,
    });
  }
};

const parseBatchOutput = (output, pathByOid) => {
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const header = output.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;

    if (header.endsWith(' missing')) continue;
    const [oid, type, sizeRaw] = header.split(' ');
    const size = Number(sizeRaw);
    if (!oid || !type || !Number.isFinite(size)) break;

    const contentEnd = offset + size;
    const content = output.subarray(offset, contentEnd);
    offset = contentEnd + 1;

    if (type !== 'blob') continue;
    const file = pathByOid.get(oid) || '<unknown-path>';
    inspectPath('history', file, oid);
    scanBuffer({ scope: 'history', file, buffer: content, blob: oid });
    stats.historyBlobsScanned += 1;
  }
};

const scanHistory = () => {
  const objectLines = runGit(['rev-list', '--objects', '--all']).split(/\r?\n/).filter(Boolean);
  const pathByOid = new Map();
  const objectIds = [];

  for (const line of objectLines) {
    const separator = line.indexOf(' ');
    const oid = separator >= 0 ? line.slice(0, separator) : line;
    const file = separator >= 0 ? line.slice(separator + 1) : '';
    objectIds.push(oid);
    if (file && !pathByOid.has(oid)) pathByOid.set(oid, file);
  }
  stats.reachableObjects = objectIds.length;

  const checkOutput = runGit(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: `${objectIds.join('\n')}\n` }
  );

  const blobIds = [];
  for (const line of checkOutput.split(/\r?\n/)) {
    const [oid, type, sizeRaw] = line.split(' ');
    const size = Number(sizeRaw);
    if (type !== 'blob' || !Number.isFinite(size)) continue;
    if (size > maxFileBytes) {
      stats.skippedLargeObjects += 1;
      inspectPath('history', pathByOid.get(oid) || '<unknown-path>', oid);
      continue;
    }
    blobIds.push(oid);
  }

  for (let index = 0; index < blobIds.length; index += HISTORY_BATCH_SIZE) {
    const batch = blobIds.slice(index, index + HISTORY_BATCH_SIZE);
    const output = runGit(
      ['cat-file', '--batch'],
      {
        input: Buffer.from(`${batch.join('\n')}\n`, 'utf8'),
        encoding: null,
      }
    );
    parseBatchOutput(output, pathByOid);
  }
};

if (mode === 'current' || mode === 'all') scanCurrentTree();
if (mode === 'history' || mode === 'all') scanHistory();

const commitCache = new Map();
for (const finding of findings) {
  if (finding.scope !== 'history' || !finding.blob) continue;
  if (!commitCache.has(finding.blob)) {
    const commit = runGit([
      'log',
      '--all',
      `--find-object=${finding.blob}`,
      '--format=%H',
      '-1',
    ]).trim();
    commitCache.set(finding.blob, commit ? commit.slice(0, 12) : null);
  }
  finding.commit = commitCache.get(finding.blob);
  delete finding.blob;
}

for (const finding of findings) delete finding.blob;

findings.sort((left, right) => (
  (SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity])
  || left.scope.localeCompare(right.scope)
  || left.file.localeCompare(right.file)
  || ((left.line || 0) - (right.line || 0))
  || left.rule.localeCompare(right.rule)
));

const severityCounts = Object.fromEntries(Object.keys(SEVERITY_ORDER).map((key) => [key, 0]));
const scopeCounts = {};
const ruleCounts = {};
for (const finding of findings) {
  severityCounts[finding.severity] += 1;
  scopeCounts[finding.scope] = (scopeCounts[finding.scope] || 0) + 1;
  ruleCounts[finding.rule] = (ruleCounts[finding.rule] || 0) + 1;
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode,
  redacted: true,
  maxFileBytes,
  summary: {
    totalFindings: findings.length,
    bySeverity: severityCounts,
    byScope: scopeCounts,
    byRule: ruleCounts,
    stats,
  },
  findings,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('Secret scan complete (matched values are redacted).');
console.log(`Mode: ${mode}`);
console.log(`Findings: ${findings.length}`);
console.log(`By severity: ${JSON.stringify(severityCounts)}`);
console.log(`Report: ${path.relative(repositoryRoot, reportPath)}`);

if (failOn !== 'none') {
  const threshold = SEVERITY_ORDER[failOn];
  if (findings.some((finding) => SEVERITY_ORDER[finding.severity] >= threshold)) {
    process.exitCode = 2;
  }
}
