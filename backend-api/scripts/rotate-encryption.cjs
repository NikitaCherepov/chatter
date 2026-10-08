'use strict';
// Offline only: no application imports, migrations, schedulers or network calls.
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const FIELDS = [
  ['api_keys', 'key_encrypted', '::'],
  ['mail_accounts', 'imap_pass', '::'],
  ['smart_home_settings', 'token_enc', ':', '', true],
  ['chatgpt_connections', 'credentials', 'gcm'],
  ['devops_servers', 'password_enc', ':', 'DEVOPS_ENCRYPTION_KEY', true],
  ['devops_servers', 'private_key_enc', ':', 'DEVOPS_ENCRYPTION_KEY', true],
  ['devops_servers', 'sudo_password_enc', ':', 'DEVOPS_ENCRYPTION_KEY', true],
  ['devops_ssh_keys', 'public_key_enc', ':', 'DEVOPS_ENCRYPTION_KEY', true],
  ['devops_ssh_keys', 'private_key_enc', ':', 'DEVOPS_ENCRYPTION_KEY', true],
  ['map_pins', 'lat_enc', ':', 'MAP_PINS_ENCRYPTION_KEY', true],
  ['map_pins', 'lng_enc', ':', 'MAP_PINS_ENCRYPTION_KEY', true],
];
const key = source => crypto.createHash('sha256').update(source).digest();
function decrypt(value, source, format, legacy = false) {
  if (format === 'gcm') {
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some(p => !/^[\w-]*$/.test(p))) throw new Error('invalid_ciphertext');
    const [iv, data, tail, tag] = parts.map(p => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_ciphertext');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key(source), iv);
    cipher.setAuthTag(tag);
    const plain = Buffer.concat([cipher.update(data), cipher.update(tail), cipher.final()]);
    JSON.parse(plain.toString('utf8'));
    return plain;
  }
  const parts = value.split(format);
  // These services explicitly support legacy plaintext; do not double-encrypt it.
  if (legacy && parts.length !== 2) return null;
  if (parts.length !== 2 || !/^[a-f\d]{32}$/i.test(parts[0]) || !/^(?:[a-f\d]{32})+$/i.test(parts[1])) throw new Error('invalid_ciphertext');
  const cipher = crypto.createDecipheriv('aes-256-cbc', key(source), Buffer.from(parts[0], 'hex'));
  const plain = Buffer.concat([cipher.update(Buffer.from(parts[1], 'hex')), cipher.final()]);
  new TextDecoder('utf-8', { fatal: true }).decode(plain);
  return plain;
}
function encrypt(plain, source, format) {
  const iv = crypto.randomBytes(format === 'gcm' ? 12 : 16);
  const cipher = crypto.createCipheriv(format === 'gcm' ? 'aes-256-gcm' : 'aes-256-cbc', key(source), iv);
  const data = cipher.update(plain);
  const tail = cipher.final();
  return format === 'gcm'
    ? [iv, data, tail, cipher.getAuthTag()].map(p => p.toString('base64url')).join('.')
    : iv.toString('hex') + format + Buffer.concat([data, tail]).toString('hex');
}
function rotateDatabase(file, oldSource, newSource, overrides = {}, verifyOnly = false) {
  if (!oldSource || !newSource) throw new Error('encryption_key_missing');
  const db = new Database(file, { fileMustExist: true, readonly: verifyOnly });
  let count = 0;
  try {
    db.pragma('busy_timeout = 5000');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('database_integrity_failed');
    db.transaction(() => {
      for (const [table, column, format, override, legacy] of FIELDS) {
        if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)) continue;
        if (!db.pragma(`table_info(${table})`).some(c => c.name === column)) continue;
        const source = overrides[override] || oldSource;
        const target = overrides[override] || newSource;
        const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
        const select = db.prepare(`SELECT rowid AS rotation_row, ${column} AS value FROM ${table} WHERE (? IS NULL OR rowid > ?) ORDER BY rowid LIMIT 200`);
        let cursor = null;
        for (;;) {
          const batch = select.all(cursor, cursor);
          if (!batch.length) break;
          for (const row of batch) {
            if (row.value === null || row.value === '') continue;
            try {
              const plain = decrypt(row.value, source, format, legacy);
              if (plain === null) continue;
              if (!verifyOnly && !overrides[override]) {
                const next = encrypt(plain, target, format);
                if (!decrypt(next, target, format).equals(plain)) throw new Error('verification_failed');
                update.run(next, row.rotation_row);
                count++;
              }
            } catch {
              // Never include plaintext, ciphertext, credentials or provider errors.
              throw new Error(`cannot_reencrypt:${table}.${column}:row_${row.rotation_row}`);
            }
          }
          cursor = batch[batch.length - 1].rotation_row;
        }
      }
    })();
    if (!verifyOnly) db.pragma('wal_checkpoint(TRUNCATE)');
    return { fields: count };
  } finally { db.close(); }
}
module.exports = { rotateDatabase, encrypt, decrypt, FIELDS };
if (require.main === module) {
  if (process.argv.includes('--probe')) process.stdout.write(JSON.stringify({ version: 1 }));
  else {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; if (input.length > 65536) process.exit(1); });
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(input);
        process.stdout.write(JSON.stringify(rotateDatabase(data.file, data.oldKey, data.newKey, data.overrides, data.verifyOnly)));
      } catch (error) {
        process.stderr.write(error.message.startsWith('cannot_reencrypt:') ? error.message : 'encryption_rotation_failed');
        process.exitCode = 1;
      }
    });
  }
}
