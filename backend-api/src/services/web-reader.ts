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

  // Используем мощный stealth BQL эндпоинт
  // proxy=residential убрал, чтобы не сжечь твои лимиты, но если он тебе нужен — верни.
  const endpoint = `${BROWSERLESS_BASE_URL}/stealth/bql?token=${encodeURIComponent(BROWSERLESS_TOKEN)}&blockConsentModals=true`;

  // Пишем мутацию на BQL. Используем переменные GraphQL, чтобы не словить ошибку из-за спецсимволов в URL
  const query = `
    mutation ExtractText($target: String!) {
      viewport(width: 1366, height: 768) {
        status
      }
      goto(url: $target, waitUntil: domcontentloaded) {
        status
      }
      text {
        text
      }
    }
  `;

  try {
    const response = await axios.post(endpoint, {
      query: query,
      variables: { target: url }
    }, { timeout: 60_000 });

    // Достаем текст из ответа BQL
    // Структура ответа: { data: { text: { text: "..." } } }
    const rawText = response.data?.data?.text?.text || '';
    
    // Чистим текст от гигантских пробелов и переносов
    const cleanText = rawText.replace(/\s+/g, ' ').trim();

    if (!cleanText) {
      return 'Текст на странице не найден или страница пуста после рендера (возможно, стоит жесткая капча).';
    }

    // Обрезаем до 15к символов, чтобы не взорвать контекст Gemini
    return cleanText.slice(0, 15000);

  } catch (error: any) {
    console.error('Browserless BQL Error:', error?.response?.data || error.message);
    return `Ошибка при чтении страницы: ${error.message}`;
  }
};