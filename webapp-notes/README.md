# webapp-notes

Telegram Web App для заметок (Next.js SSR + SQLite).

## Env

Скопируй `.env.example` в `.env` и укажи:

- `TELEGRAM_TOKEN` — токен того же бота (`TELEGRAM_BOT_TOKEN` тоже поддерживается для совместимости).
- `NOTES_DB_PATH` — путь к `chatter.db` (по умолчанию `../chatter.db`).
- `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS` — срок действия Telegram `initData` в секундах (по умолчанию 3600).

## Run

```bash
npm install
npm run dev
```

Прод URL добавь в бот через `NOTES_WEBAPP_URL` в основном `.env`.
