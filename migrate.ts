import OpenAI from 'openai';
import * as dotenv from 'dotenv';
dotenv.config();

// --- НАСТРОЙКИ ---
const USER_ID = "0";
const PINECONE_API_KEY = 'token';
const PINECONE_HOST = ""; // Например: bot-memory-666.svc.gcp-us-east1.pinecone.io
const OLD_INDEX_NAME = "chattermemory";
const NEW_INDEX_NAME = "chattermemory2";

const openai = new OpenAI({
  apiKey: process.env.TIMEWEB_EMBED_API_KEY,
  baseURL: process.env.TIMEWEB_EMBED_BASE_URL
});

async function migrate() {
  console.log(`🚀 Начинаем миграцию (REST-версия) для ${USER_ID}...`);

  // 1. Получаем список ID через REST
  const listUrl = `https://${PINECONE_HOST}/vectors/list?namespace=${USER_ID}`;
  const listResp = await fetch(listUrl, { headers: { 'Api-Key': PINECONE_API_KEY } });
  const listData: any = await listResp.json();
  
  const allIds: string[] = Array.isArray(listData.vectors)
    ? listData.vectors
        .map((vector: { id?: unknown }) => `${vector.id || ''}`.trim())
        .filter(Boolean)
    : [];
  if (allIds.length === 0) {
    console.log("📭 Записей не найдено.");
    return;
  }
  console.log(`✅ Найдено ${allIds.length} записей.`);

  let successCount = 0;
  const BATCH_SIZE = 10;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);
    
    // 2. Достаем ТЕЛА записей (Fetch через REST)
    // Формируем строку: ids=id1&ids=id2...
    const idsParams = batchIds.map(id => `ids=${encodeURIComponent(id)}`).join('&');
    const fetchUrl = `https://${PINECONE_HOST}/vectors/fetch?${idsParams}&namespace=${USER_ID}`;
    
    const fetchResp = await fetch(fetchUrl, { headers: { 'Api-Key': PINECONE_API_KEY } });
    const fetchData: any = await fetchResp.json();
    
    const records = Object.values(fetchData.vectors || {});
    if (records.length === 0) {
      console.warn(`⚠️ Батч ${i}: Не удалось достать записи по ID.`);
      continue;
    }

    // 3. Делаем новые эмбеддинги через настроенный OpenAI-совместимый API
    const texts = records.map((r: any) => r.metadata?.text).filter(Boolean);
    const embedResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts
    });

    // 4. Заливаем в НОВУЮ базу (через твой основной способ, он-то работает)
    // Но чтобы не рисковать, сделаем через REST Upsert
    // Сначала найдем HOST нового индекса (он другой!)
    const NEW_HOST = PINECONE_HOST.replace(OLD_INDEX_NAME, NEW_INDEX_NAME); 
    // ^ ВНИМАНИЕ: Если имена индексов сильно разные, лучше вставь Host нового вручную

    const toUpsert = records.map((r: any, idx: number) => ({
      id: r.id,
      values: embedResponse.data[idx].embedding,
      metadata: r.metadata
    }));

    const upsertUrl = `https://${PINECONE_HOST}/vectors/upsert`; // Для простоты шлем в тот же проект
    // Но лучше просто используй свой VectorMemoryService для загрузки в новый индекс здесь
    
    // ВАЖНО: Просто подставь здесь вызов своего сервиса, раз он у тебя работает:
    // Или используй этот REST запрос:
    await fetch(`https://${PINECONE_HOST.replace(OLD_INDEX_NAME, NEW_INDEX_NAME)}/vectors/upsert`, {
      method: 'POST',
      headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: toUpsert, namespace: USER_ID })
    });

    successCount += toUpsert.length;
    console.log(`📈 Прогресс: ${successCount} / ${allIds.length}`);
  }

  console.log(`\n🏁 Успех! Перенесено: ${successCount}`);
}

migrate();
