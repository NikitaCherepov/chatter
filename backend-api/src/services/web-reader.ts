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

/** Escapes closing tags inside content to prevent break-out from untrusted data wrappers. */
export const wrapUntrustedContent = (content: string): string => {
  const sanitized = content.replace(/<\/untrusted_web_content>/gi, '<untrusted_web_content>')
    .replace(/<\/untrusted_>/gi, '<untrusted_>');
  return `<untrusted_web_content>${sanitized}</untrusted_web_content>`;
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
      solve(wait: true) { time }
      text(selector: "body") { text }
    }
  `;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { target: url },
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const responseData = await response.json() as any;
    if (!response.ok) {
      throw new Error(`browserless_http_${response.status}: ${JSON.stringify(responseData).slice(0, 1000)}`);
    }

    // ПРОВЕРКА НА ВНУТРЕННИЕ ОШИБКИ GRAPHQL
    if (responseData?.errors && responseData.errors.length > 0) {
      const errorMsg = responseData.errors.map((e: any) => e.message).join(' | ');
      console.error('GraphQL Internal Errors:', errorMsg);
      return `Ошибка парсера (GraphQL): ${errorMsg}`;
    }

    const rawText = responseData?.data?.text?.text || '';
    const cleanText = rawText.replace(/\s+/g, ' ').trim();

    if (!cleanText) {
      return 'Текст на странице не найден или контент заблокирован (возможно, пустой body).';
    }

    return wrapUntrustedContent(cleanText.slice(0, 15000));

  } catch (error: any) {
    const errorDetails = error?.message || String(error);
    console.error('Browserless BQL HTTP Error:', errorDetails);
    return `HTTP Ошибка при чтении страницы: ${errorDetails}`;
  }
};
