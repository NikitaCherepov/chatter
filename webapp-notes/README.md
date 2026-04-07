# webapp-notes

Telegram Web App для заметок (Next.js SSR + SQLite).

## Env

Скопируй `.env.example` в `.env` и укажи:

- `TELEGRAM_BOT_TOKEN` — токен того же бота.
- `NOTES_DB_PATH` — путь к `chatter.db` (по умолчанию `../chatter.db`).

## Run

```bash
npm install
npm run dev
```

Прод URL добавь в бот через `NOTES_WEBAPP_URL` в основном `.env`.
