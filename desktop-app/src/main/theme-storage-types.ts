export type ThemeStorageValue =
  null | boolean | number | string | ThemeStorageValue[] | { [key: string]: ThemeStorageValue };
export type ThemeStorageSnapshot = { revision: number; values: Record<string, ThemeStorageValue> };
export type ThemeStorageRequest =
  | { operation: 'read' }
  | { operation: 'set'; key: string; value: ThemeStorageValue; revision?: number }
  | { operation: 'remove'; key: string; revision?: number };
export const THEME_STORAGE_LIMITS = {
  keys: 1024,
  keyLength: 200,
  valueBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
};
export const validThemeStorageId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
export const validThemeStorageKey = (key: unknown): key is string =>
  typeof key === 'string' &&
  key.length > 0 &&
  key.length <= THEME_STORAGE_LIMITS.keyLength &&
  !/[\x00-\x1f]/.test(key) &&
  !['__proto__', 'prototype', 'constructor'].includes(key);

/** Clone only JSON data. Reject silent JSON conversions (NaN, Date, undefined, cycles). */
export function cloneThemeStorageValue(input: unknown): ThemeStorageValue {
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): ThemeStorageValue => {
    if (depth > 64) throw new Error('theme_storage_invalid_value');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || !value || ancestors.has(value))
      throw new Error('theme_storage_invalid_value');
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new Error('theme_storage_invalid_value');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('theme_storage_invalid_value');
    ancestors.add(value);
    let result: ThemeStorageValue;
    if (Array.isArray(value)) result = Array.from(value, (item) => visit(item, depth + 1));
    else {
      result = {};
      for (const key of Object.keys(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new Error('theme_storage_invalid_value');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new Error('theme_storage_invalid_value');
        (result as Record<string, ThemeStorageValue>)[key] = visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
    return result;
  };
  const result = visit(input, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > THEME_STORAGE_LIMITS.valueBytes)
    throw new Error('theme_storage_value_too_large');
  return result;
}
