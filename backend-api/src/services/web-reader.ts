import axios from 'axios';
import * as cheerio from 'cheerio'; // Убедись, что сделал: npm install cheerio

// Жестко прибиваем гвоздями рабочий домен v1/v2
const BROWSERLESS_BASE_URL = 'https://chrome.browserless.io';
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

  // Используем самый стабильный эндпоинт, он есть на всех серверах
  const endpoint = `${BROWSERLESS_BASE_URL}/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;

  try {
    const response = await axios.post(
      endpoint,
      { url: url }, // Просто кидаем URL, никаких сложных GraphQL-запросов
      { 
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000 
      }
    );

    // Получили сырой HTML
    const html = response.data;
    
    // Чистим его локально через Cheerio
    const $ = cheerio.load(html);
    $('script, style, svg, nav, footer, header, noscript, iframe').remove();
    
    let cleanText = $('body').text().replace(/\s+/g, ' ').trim();

    if (!cleanText) {
      return 'Текст на странице не найден или страница пуста после рендера.';
    }

    return cleanText.slice(0, 15000);

  } catch (error: any) {
    // Выводим РЕАЛЬНУЮ ошибку от Browserless, а не просто "404"
    const errorDetails = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error('Browserless Error:', errorDetails);
    return `Ошибка при чтении страницы: ${error.response?.status} - ${errorDetails}`;
  }
};