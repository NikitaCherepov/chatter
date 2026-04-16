import axios from 'axios';

const optionalRequire = (moduleName: string) => {
  try {
    const req = (0, eval)('require');
    return req(moduleName);
  } catch {
    return null;
  }
};

const BROWSERLESS_BASE_URL = (process.env.BROWSERLESS_BASE_URL || 'https://chrome.browserless.io').trim().replace(/\/$/, '');
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

  const endpoint = `${BROWSERLESS_BASE_URL}/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const response = await axios.post(endpoint, { url }, { timeout: 60_000, responseType: 'text' });
  const html = typeof response.data === 'string' ? response.data : `${response.data || ''}`;

  const cheerio = optionalRequire('cheerio');
  let cleanText = '';

  if (cheerio?.load) {
    const $ = cheerio.load(html);
    $('script, style, svg, nav, footer, header, noscript').remove();
    cleanText = $('body').text();
  } else {
    cleanText = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }

  cleanText = cleanText.replace(/\s+/g, ' ').trim();
  if (!cleanText) {
    return 'Текст на странице не найден или страница пуста после рендера.';
  }

  return cleanText.slice(0, 15000);
};
