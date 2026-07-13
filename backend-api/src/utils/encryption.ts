import crypto from 'node:crypto';

export const getEncryptionKey = (
  envNames: string[],
  missingKeyError = 'encryption_key_not_configured',
): Buffer => {
  const source = envNames
    .map((name) => process.env[name])
    .find((value): value is string => typeof value === 'string' && value.length > 0);

  if (!source) throw new Error(missingKeyError);
  return crypto.createHash('sha256').update(source).digest();
};
