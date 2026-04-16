# chatter backend-api

## Run (dev)

```bash
npm run dev:api
```

## Build

```bash
npm run build:api
```

## PM2

```bash
npm run start:api
npm run logs:api
```

## Required env

- `TELEGRAM_TOKEN`
- `API_JWT_SECRET` (optional, fallback to TELEGRAM_TOKEN)
- `BACKEND_API_PORT` (default `3050`)
- `API_DB_PATH` (default `../chatter.db`)
- model keys/base URLs from current bot env (`TIMEWEB_*`).

## REST v1

- `POST /api/v1/auth/telegram`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/chats`
- `POST /api/v1/chats`
- `POST /api/v1/chats/:id/activate`
- `GET /api/v1/chats/:id/messages?limit=&offset=`
- `POST /api/v1/chat/send`
- `GET /api/v1/notes?query=&limit=&offset=`
- `POST /api/v1/notes`
- `DELETE /api/v1/notes/:id`
- `GET /api/v1/tasks?status=&limit=`
- `POST /api/v1/tasks`
- `DELETE /api/v1/tasks/:id`
