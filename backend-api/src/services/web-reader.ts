import axios from 'axios';

// Используем базовый урл. Если в .env ничего нет, берем рабочий production-sfo
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

  // Тот самый рабочий Stealth эндпоинт
  const endpoint = `${BROWSERLESS_BASE_URL}/stealth/bql?token=${encodeURIComponent(BROWSERLESS_TOKEN)}&blockConsentModals=true`;

  // Идеально выверенная мутация
  const query = `
    mutation ScrapeTarget($target: String!) {
      goto(url: $target, waitUntil: networkIdle) { status }
      solve(wait: true) { status }
      text(selector: "body") { text }
    }
  `;

  try {
    const response = await axios.post(
      endpoint,
      {
        query: query,
        variables: { target: url }
      },
      { 
        headers: { 'Content-Type': 'application/json' },
        timeout: 45000 // Даем браузеру время отрендерить React/Vue
      }
    );

    // ПРОВЕРКА НА ВНУТРЕННИЕ ОШИБКИ GRAPHQL
    if (response.data?.errors && response.data.errors.length > 0) {
      const errorMsg = response.data.errors.map((e: any) => e.message).join(' | ');
      console.error('GraphQL Internal Errors:', errorMsg);
      return `Ошибка парсера (GraphQL): ${errorMsg}`;
    }

    const rawText = response.data?.data?.text?.text || '';
    const cleanText = rawText.replace(/\s+/g, ' ').trim();

    if (!cleanText) {
      return 'Текст на странице не найден или контент заблокирован (возможно, пустой body).';
    }

    return cleanText.slice(0, 15000);

  } catch (error: any) {
    const errorDetails = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error('Browserless BQL HTTP Error:', errorDetails);
    return `HTTP Ошибка при чтении страницы: ${error.message}`;
  }
};
