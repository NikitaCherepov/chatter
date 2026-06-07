import { XMLParser } from 'fast-xml-parser';
import { db, getNowUnix } from '../db.js';

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

interface CbrValute {
 CharCode: string;
  Name: string;
  Nominal: string | number;
  Value: string;
}

interface CurrencyRateRow {
  code: string;
  name: string;
  value: number;
  prev_value: number | null;
  nominal: number;
  updated_at: number;
}

/**
 * Fetches exchange rates from CBR XML API and upserts into currency_rates table.
 * Old value shifts to prev_value before new value is written.
 */
export const fetchAndSaveCurrencyRates = async (): Promise<void> => {
  console.log('[currency] fetching CBR rates...');

  const response = await fetch(CBR_URL);
  if (!response.ok) {
    throw new Error(`CBR API returned ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);

  const valutes: CbrValute[] = parsed?.ValCurs?.Valute;
  if (!Array.isArray(valutes) || valutes.length === 0) {
    throw new Error('CBR API returned no valutes');
  }

  const now = getNowUnix();
  const upsert = db.prepare(`
    INSERT INTO currency_rates (code, name, value, prev_value, nominal, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      prev_value = currency_rates.value,
      value = excluded.value,
      nominal = excluded.nominal,
      updated_at = excluded.updated_at
  `);

  const insertMany = db.transaction(() => {
    for (const v of valutes) {
      const code = (v.CharCode || '').trim();
      if (!code) continue;

      const name = (v.Name || '').trim();
      const nominal = Math.max(1, Number(v.Nominal) || 1);
      const rawValue = (v.Value || '0').replace(',', '.').trim();
      const value = parseFloat(rawValue);

      if (isNaN(value) || value <= 0) continue;

      upsert.run(code, name, value, null, nominal, now);
    }
  });

  insertMany();
  console.log(`[currency] saved ${valutes.length} rates from CBR`);
};

/**
 * Get a single currency rate by code.
 */
export const getCurrencyRate = (code: string): CurrencyRateRow | null => {
  return db.prepare('SELECT code, name, value, prev_value, nominal, updated_at FROM currency_rates WHERE code = ?').get(code.toUpperCase().trim()) as CurrencyRateRow | null;
};

/**
 * Get multiple currency rates by codes. If codes is empty, returns all.
 */
export const getCurrencyRates = (codes?: string[]): CurrencyRateRow[] => {
  if (!codes || codes.length === 0) {
    return db.prepare('SELECT code, name, value, prev_value, nominal, updated_at FROM currency_rates ORDER BY code').all() as CurrencyRateRow[];
  }
  const placeholders = codes.map(() => '?').join(',');
  return db.prepare(`SELECT code, name, value, prev_value, nominal, updated_at FROM currency_rates WHERE code IN (${placeholders}) ORDER BY code`).all(...codes.map(c => c.toUpperCase().trim())) as CurrencyRateRow[];
};

/**
 * Formats a human-readable rate string for AI consumption.
 */
export const formatRateForAi = (row: CurrencyRateRow): string => {
  const change = row.prev_value !== null ? row.value - row.prev_value : null;
  const changeStr = change !== null
    ? (change > 0 ? `(+${change.toFixed(4)})` : change < 0 ? `(${change.toFixed(4)})` : '(без изменений)')
    : '(нет данных за прошлый день)';

  const nominalStr = row.nominal > 1 ? `${row.nominal} ` : '';
  return `${row.code} (${row.name}): ${nominalStr}${row.value.toFixed(4)} RUB ${changeStr}`;
};
