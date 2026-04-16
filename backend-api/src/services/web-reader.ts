import axios from 'axios';

const BROWSERLESS_BASE_URL = (process.env.BROWSERLESS_BASE_URL || 'https://production-sfo.browserless.io').trim().replace(/\/$/, '');
const BROWSERLESS_TOKEN = (process.env.BROWSERLESS_TOKEN || '').trim();

const isHttpUrl = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

export const getCleanTextFromUrl = async (targetUrl: string) => {
  const url = `${targetUrl || ''}`.trim();
  if (!url) throw new Error('url_required');
  if (!isHttpUrl(url)) throw new Error('bad_url');
  if (!BROWSERLESS_TOKEN) throw new Error('browserless_token_missing');

  const endpoint = `${BROWSERLESS_BASE_URL}/scrape?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const response = await axios.post(endpoint, {
    url,
    elements: [
      { selector: 'article', timeout: 5000 },
      { selector: 'main', timeout: 5000 },
      { selector: 'body', timeout: 5000 }
    ]
  }, { timeout: 60_000 });

  const entries = Array.isArray(response.data?.data) ? response.data.data : [];
  const chunks: string[] = [];

  for (const entry of entries) {
    const results = Array.isArray(entry?.results) ? entry.results : [];
    for (const result of results) {
      const text = `${result?.text || ''}`.replace(/\s+/g, ' ').trim();
      if (text) chunks.push(text);
    }
  }

  const uniqueChunks = [...new Set(chunks)];
  const cleanText = uniqueChunks.join('\n\n').trim();
  if (!cleanText) {
    return 'Текст на странице не найден или страница пуста после рендера.';
  }

  return cleanText.slice(0, 15000);
};
