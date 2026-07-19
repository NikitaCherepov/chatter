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

Локально приложение открывается на `http://127.0.0.1:3001/notes`.
При серверной установке Caddy публикует его как `https://SERVER_IP/notes`,
а установщик записывает этот адрес в `NOTES_WEBAPP_URL` автоматически.
