import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
dotenv.config(); // Подтягиваем твои ключи из .env

// 1. Настройки
const userId = "0"; // Замени на свой цифровой ID, в котором лежат векторы

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY as string });
const oldIndex = pinecone.index('chattermemory');       // Укажи точное имя старого индекса
const newIndex = pinecone.index('chattermemory2'); // Укажи точное имя нового индекса (размерность 1536)

const openai = new OpenAI({
  apiKey: process.env.PROXYAPI_KEY, // Убедись, что ключ есть в .env
  baseURL: 'https://api.proxyapi.ru/openai/v1' // Точный URL из документации ProxyAPI
});

async function migrate() {
  console.log(`Начинаем миграцию для пользователя ${userId}...`);
  
  let allIds: string[] = [];
  let paginationToken = undefined;

  // Собираем все ID из старой базы
  do {
    const listResponse = await oldIndex.namespace(userId).listPaginated({
      paginationToken: paginationToken
    });
    
    if (listResponse.vectors) {
      allIds.push(...listResponse.vectors.map(v => v.id));
    }
    paginationToken = listResponse.pagination?.next;
  } while (paginationToken);

  console.log(`Найдено ${allIds.length} записей. Начинаем перенос...`);

  // Обрабатываем батчами по 50 штук
  const BATCH_SIZE = 50;
  
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);
    
    // Достаем тексты
    const fetchResponse = await oldIndex.namespace(userId).fetch(batchIds);
    const records = Object.values(fetchResponse.records);
    const textsToEmbed = records.map(record => record.metadata.text as string);

    // Генерируем новые векторы
    const embedResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: textsToEmbed
    });

    // Формируем новые записи
    const newVectors = records.map((record, index) => ({
      id: record.id,
      values: embedResponse.data[index].embedding,
      metadata: record.metadata
    }));

    // Заливаем в новый индекс
    await newIndex.namespace(userId).upsert(newVectors);
    
    console.log(`Мигрировано: ${i + batchIds.length} / ${allIds.length}`);
    
    // Искусственная задержка на полсекунды, чтобы ProxyAPI не выдал ошибку Rate Limit
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('Миграция успешно завершена! Можно менять индекс в основном коде.');
}

migrate().catch(console.error);