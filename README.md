# Chatter Bot (`index.ts`)

Telegram-бот проекта `chatter`.

`index.ts` отвечает за Telegram UX (команды, меню, обработку текста/голоса/фото) и ходит в `backend-api` через internal API для AI и управления пользователями.

## Что важно понимать

- Бот и API запускаются как два отдельных процесса.
- Для user lifecycle бот использует backend (`/internal/users/*`), поэтому backend должен быть запущен.
- Основная БД проекта: `chatter.db`.

## Быстрый старт

1. Установить зависимости:

```bash
npm install
```

2. Настроить `.env` (минимум см. ниже).
3. Запустить backend API:

```bash
npm run dev:api
```

4. В другом терминале запустить бота:

```bash
npm run dev
```

## PM2 запуск

```bash
npm run start:api
npm run start
```

```bash
npm run logs:api
npm run logs
```

## Минимальные ENV для бота

- `TELEGRAM_TOKEN` - токен Telegram-бота.
- `BACKEND_INTERNAL_TOKEN` - должен совпадать с backend.
- `BACKEND_API_BASE_URL` - по умолчанию `http://127.0.0.1:3050`.

## Рекомендуемые ENV

- `ADMIN_IDS` или `ADMIN_ID` - чтобы назначить админов.
- `ENCRYPTION_KEY` - ключ шифрования для mail-данных.
- `NOTES_WEBAPP_URL` - ссылка на WebApp заметок в меню.
- `AUTO_SYNC_PLAN_LIMITS_ON_BOOT=1` - авто-синхронизация лимитов при старте.
- `BACKEND_TIMEOUT_AI_MS` - таймаут AI-запросов (ms), по умолчанию `120000` (2 мин).
- `BACKEND_TIMEOUT_MEDIA_MS` - таймаут голоса/фото (ms), по умолчанию `180000` (3 мин).
- `BACKEND_TIMEOUT_DEFAULT_MS` - таймаут прочих запросов к backend (ms), по умолчанию `15000` (15 сек).

## AI-инструменты

Бот получает список инструментов из backend и передаёт их AI. Доступные:

- **search_web** - поиск в интернете (Tavily).
- **read_webpage** - чтение и очистка текста веб-страницы.
- **control_smart_home** - управление устройствами умного дома.
- **schedule_task** / **get_my_tasks** / **delete_my_task** - планирование задач и напоминаний.
- **set_user_timezone** - установка часового пояса.
- **check_emails** / **read_email_content** / **send_email** - работа с почтой.
- **save_note** / **list_my_notes** / **read_note** / **delete_note** - заметки.
- **update_core_memory** - статический профиль пользователя.
- **search_cold_memory** / **save_to_cold_memory** / **delete_from_cold_memory** - векторный архив памяти.
- **random_roll** - бросок монетки/кубиков.
- **generate_image** - генерация изображений по текстовому описанию. Вызывается при явном намерении ("нарисуй", "сгенерируй картинку"). Промпт автоматически переводится на английский. Изображение отправляется в Telegram как фото.

## Основные команды

Пользователь:

- `/start`, `/menu`
- `/clear`
- `/tz <UTC>`
- `/tasks`, `/task_delete <id>`
- `/note_add <текст>`, `/notes`, `/note_find <текст>`, `/note_delete <id>`
- `/mail_setup <prov> <mail> <app_pass>`, `/mail_use <yandex|google>`, `/mail_limit`, `/mail_forget`
- `/chats`, `/chat_new [название]`, `/chat_use <id>`
- `/rename`
- `/prompts`, `/prompt_use <id>`

Desktop (дополнительно):

- Полнотекстовый поиск по сообщениям в сайдбаре (FTS5, debounce 300 мс)
- `GET /api/v1/chats/search?q=keyword` — возвращает чаты со сниппетами найденных сообщений

Админ (дополнительно):

- `/add`, `/remove`
- `/users`
- `/ban <id> [причина]`, `/unban <id>`
- `/prompt_add`, `/prompt_show`, `/prompt_set`, `/prompt_desc`, `/prompt_rename`, `/prompt_default`, `/prompt_delete`
- `/history_user <user_id> [limit]`
- `/history_delete <user_id> <message_id> [db|tg]`
- `/sync_plan_limits`

## Сборка

```bash
npm run build
```

Скомпилированный файл: `dist/index.js`.

## Если бот не отвечает

1. Проверить, что backend жив:

```bash
curl -s http://127.0.0.1:3050/health
```

2. Проверить логи:

```bash
npm run logs:api
npm run logs
```

3. Проверить, что `BACKEND_INTERNAL_TOKEN` одинаковый у бота и backend.

## Смежная документация

- API backend: [backend-api/README.md](./backend-api/README.md)

## Changelog

### 2025-05-03: Agent Loop Fix + SSE Streaming для Desktop

**Баг:** Когда AI-модель генерировала текст и одновременно вызывала инструмент (например `set_display_state`), текст терялся. На следующем шаге модель возвращала `content: null`, и в интерфейс вылезал JSON-ответ инструмента (`{"status":"success",...}`) вместо нормального текста.

**Фикс в `ai.ts`:**
- Добавлены переменные `fullDbHistory` (весь текст для БД) и `finalAnswer` (текст для отправки юзеру).
- Текст, сгенерированный на промежуточных шагах агентского цикла, теперь сохраняется в буфер и не теряется.
- Запись в БД использует `fullDbHistory`, а не обрезанный `answer`.
- Добавлены коллбэки `onIntermediateMessage`, `onStateChange`, `onToolStatus` для real-time передачи событий.

**SSE Streaming для Desktop:**
- `/api/v1/chat/send` переведён на SSE (Server-Sent Events). Desktop-клиент получает промежуточные ответы, статусы тулзов и изменения аватара в реалтайме, не дожидаясь завершения всего цикла.
- В `desktop-app/api.ts` добавлена функция `streamChatMessage` с поддержкой refresh-токенов.
- `ChatPage.tsx` обновлён: три точки заменяются на реальный баббл при первом приходе контента, последующий текст дописывается в него.

