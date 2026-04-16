const axios = require('axios');

const TOKEN = 'token';
const ENDPOINT = `https://production-sfo.browserless.io/stealth/bql?token=${TOKEN}&blockConsentModals=true`;

// 1. Меняем waitUntil на networkidle2 (ждем завершения всех сетевых запросов SPA)
// 2. Добавляем вызов html { html }, чтобы увидеть структуру страницы
const query = `
  mutation ScrapeVK($target: String!) {
    viewport(width: 1366, height: 768) { 
      width 
      height 
    }
    goto(url: $target, waitUntil: networkIdle) { 
      status 
    }
solve(wait: true) { time }
    text(selector: "body") { 
      text 
    }
  }
`;

async function testStealthBQL() {
    console.log('🚀 Запускаем Stealth BQL тест. Цель: Выбить дверь ВК...');
    try {
        const response = await axios.post(
            ENDPOINT,
            {
                query: query,
                variables: { target: "https://vk.com/" }
            },
            { 
                headers: { 'Content-Type': 'application/json' },
                timeout: 45000 // Увеличили таймаут, networkidle2 ждет дольше
            }
        );
        
        console.log('✅ Сервер ответил 200 OK.\n');
        
        // ВОТ ТУТ ГЛАВНОЕ: Мы больше не парсим слепо. 
        // Мы выводим ВЕСЬ ответ, чтобы увидеть ошибки внутри GraphQL или реальный HTML.
        console.log('--- ПОЛНЫЙ JSON ОТВЕТА ---');
        
        // Аккуратно обрезаем HTML, чтобы консоль не зависла на 5 мегабайтах кода
        const dataToLog = response.data;
        if (dataToLog?.data?.html?.html) {
            dataToLog.data.html.html = dataToLog.data.html.html.slice(0, 500) + '... [HTML ОБРЕЗАН ДЛЯ КОНСОЛИ]';
        }
        
        console.log(JSON.stringify(dataToLog, null, 2));
        console.log('--------------------------');
        
    } catch (err) {
        console.error('❌ Ошибка HTTP:', err.response ? err.response.status : err.message);
        if (err.response && err.response.data) {
            console.error('Детали от Browserless:', JSON.stringify(err.response.data, null, 2));
        }
    }
}

testStealthBQL();