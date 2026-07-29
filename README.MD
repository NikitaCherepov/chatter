**English** | [Русский](docs/readme/README_RU.MD) | [Deutsch](docs/readme/README_DE.MD) | [Español](docs/readme/README_ES.MD) | [Français](docs/readme/README_FR.MD) | [Italiano](docs/readme/README_IT.MD) | [日本語](docs/readme/README_JA.MD) | [한국어](docs/readme/README_KO.MD) | [Polski](docs/readme/README_PL.MD) | [Português (BR)](docs/readme/README_PT-BR.MD) | [中文（简体）](docs/readme/README_ZH-CN.MD) | [Türkçe](docs/readme/README_TR.MD) | [Čeština](docs/readme/README_CS.MD)

[Website](https://ncherepov.ru) · [Support on Boosty](https://boosty.to/hoursen)

---

# What is Chatter?

Chatter is a multi-platform system with an AI agent that runs on a server and can be shared with friends or family in one click! You can also deploy your own service on it with plans, limits, and convenient management.

Model pricing is pulled automatically. All you need is to set a budget for the subscription.

> **Payment system is not yet integrated!**

![Chatter connects Telegram and Desktop](docs/assets/chatter-telegram-desktop.gif)

Wanted to share AI with your mom but she finds technology too complicated? Give her your Telegram bot. Zero learning curve.

Wanted your own Jarvis that turns on the lights, responds to voice commands, and lowers the blinds at night? After connecting the smart home integration, Chatter can do it without additional code or wasted tokens.

Or maybe you just wanted to roleplay with a bot but didn't want to dig through configs, spin up a local server, and figure out settings? Chatter has the most user-friendly interface and convenient admin panel (as much as possible).

The AI agent runs on the server (backend) and connects Telegram and your PC together.

```
Telegram <-> Backend <-> Desktop
```

A Telegram user can continue the same chats and control their PC while Desktop is connected. Most features are available regardless of where the message was sent from.

---

## How is the project structured?

 - **backend-api** — all server-side logic of Chatter. The agent, tools, memory, chats, limits, users, and all shared logic live here.
 - **desktop-app** — Electron app for communicating with the agent and controlling your PC.
 - **Telegram bot** — a second full-fledged interface to the same account, chats, and features. Located in the project root (inconvenient, but that's where it all started).
 - **admin-panel** — management of models, keys, users, limits, backups, and server state.
 - **chatter-manager** — connects the admin panel to Docker, allowing you to start, stop, and update components.
 - **webapp-notes** — Telegram mini-app for notes.
 - **voice-service** — optional local transcription and speech synthesis.

All server components run in separate Docker containers and are linked via Docker Compose. So you can keep only what you actually need.

---

## How to install?

 1. Rent a server and make sure to install fail2ban on it. The installer will configure UFW automatically: it will preserve access to the actual SSH port of the server and open ports 80/443 for Chatter.
 2. Open a console and run:
    ```bash
    curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
    ```
 3. **MAKE SURE** to save the login and password displayed at the end of the installation.
 4. Go to the admin panel at your server's address and enter the login and password shown in the console.
 5. Complete the steps required for the first launch:
    - Add a model and API key for Auto mode.
    - Add a model and API key for Lite mode.
    - Get a Telegram token from [BotFather](https://t.me/BotFather) and add it to the panel.
    - Optionally, copy the Webapp-Notes link provided in the panel and add it to your bot.
 6. Message the bot and approve your profile via the admin panel, then grant yourself administrator rights.

**Done!**

---

## How to connect the Desktop App?

 1. Download the app from Releases and install it. Windows may warn about a missing digital signature: the build is currently not signed with a certificate.
 2. Go to the Access Keys section in the admin panel.
 3. Create a new key and paste it into the Desktop app.
 4. Register.

**Done!**

---

## How to link your PC account and Telegram together?

 1. Go to settings on the desktop.
 2. Select "Linked accounts".
 3. Click on "Telegram".
 4. Send in the Telegram bot: `/link`
 5. Enter the code shown on screen.

**Done!**

---

## How to share it with a friend?

**Via Telegram:**
 1. Send them the Telegram bot and wait for them to message.
 2. Approve their account from the admin panel.

**Via Desktop:**
 1. Send them the Desktop app and share an Access Key to connect to your server.

**Done!**

You can always see if someone has shared your key, and you can revoke it at any time.

---

## What can the admin panel do?

![Chatter admin panel server overview](docs/assets/admin-overview.png)

 1. **Monitor component status** and restart them.
 2. **Want to add a new model?** No need to re-enter a saved API key or browse through all of OpenRouter searching for a model name.
    - API keys can be saved and reused.
    - A model search engine for OpenRouter is built into the admin panel.
    - The provider list is populated as soon as you select a model. Want requests to go only to a specific provider? Just pick it from the dropdown.
    - Input/output/cache token prices are set automatically when you select a model.
    - A Vision model is available separately — if the main model is not multimodal, it will ask Vision to describe the image you attached.

    ![Selecting a model, provider and pricing in the admin panel](docs/assets/admin-model-selection.gif)

 3. **Convenient limit management.**
    - Just set the budget a user can spend.
    - Customizable limits for images and web search for all users, plus the ability to disable image attachments.

    ![Setting up plans, budgets and limits](docs/assets/admin-plans-limits.png)

 4. **Analysis** of which models users are using, whether subagents are involved, how well messages are being cached, and much more.

    ![User statistics, connections and model usage](docs/assets/admin-user-usage.png)

 5. Backend logs and server performance graphs.
 6. Convenient integration of available services. Paste a key, enter the data, and everything works out of the box.
 7. **Custom build:**
    - Don't want the Telegram mini-app? Don't enable it.
    - No capacity for server-side TTS and voice transcription? No problem.
    - You can configure as many preset prompts for your users as you want.
 8. Need to ban a user? One click, and they immediately lose access to your server through Telegram and the Desktop app. The access key can also be revoked at any time.

---

## What can Chatter do?

 1. Use vector memory. Each user gets a separate isolated record by default. Currently only [Pinecone](https://app.pinecone.io/) integration is available.
 2. Wake on "Alexa", "Hey, Jarvis", "Hey Mycroft", or "Hey Rhasspy", with support for speech recognition and voice replies.

    ![Chatter voice activation and UI control](docs/assets/chatter-voice-activation.gif)

 3. Built into the Desktop app:
    - local Piper model for TTS;
    - native Chrome TTS model;
    - [Cartesia](https://www.cartesia.ai/) integration.
 4. Execute commands on the PC, as well as edit and read files. It can be used as a CLI.

    ![Chatter creates and opens a website on its own](docs/assets/chatter-site-creation.gif)

 5. Read and send emails from mailboxes you've added. Currently, convenient guided integration is available for [Gmail](https://mail.google.com/mail/) and [Yandex](https://mail.yandex.ru/), as well as any other email you can configure manually. Sending emails requires user confirmation.
 6. Use web search via the [Tavily](https://www.tavily.com/) service.
 7. Read and parse websites using [Browserless](https://www.browserless.io/pricing).
 8. Generate images from a reference or from text via OpenRouter.
 9. Use subagents for any task.

    ![Chatter parallel subagents at work](docs/assets/chatter-parallel-subagents.gif)

 10. Invoke specialized agents. For example: compressing and converting videos to other formats.
 11. Manage your servers. The bot never sees your SSH key or sudo password. For command execution, an SSH session opens directly on your server. The SSH key can be pulled with one button straight from your computer.
 12. Save and use Runbook instructions for later use, and share them with others.
 13. Save macros for dramatic control (*Alexa, it's time to work!*).
 14. Custom prompts, plus an AI editor built right into the panel for convenient editing.
 15. Set tasks and reminders. For example: turn on the light, remind you to discard the eye drops in a month, or check the server (only if commands are in the allowed list) while you sleep.
 16. Control your pixel avatar and adjust its mood to the conversation right on screen. Also display any images and GIFs it found on the internet on it.
 17. Create pixel art and output it directly to the pixel avatar.
 18. Save chats as DOCX, send messages from a chat directly to a linked Telegram account, plus many other Quality of Life features.
 19. Like roleplaying with bots? **Dice Mode** is built in, rolling a d20 on every message you send and influencing the story!
 20. Control the map built into the app interface, remember points on the map, and plot routes (but double-check the info!).
 21. Save notes to your notebook, which is also accessible from the Telegram app.
 22. Configure context size, conveniently select models for subagents without touching configs, and set reasoning levels (currently available for OpenRouter, DeepSeek, and Xiaomi providers).
 23. Control the webcam, take screenshots, and click on the screen while Desktop is connected. Any such action requires your confirmation.
 24. Most features are accessible from Telegram with a convenient menu and inline buttons.
 25. Control your smart home and turn on lights on a schedule. Yandex integration is available; Zigbee support is currently experimental and needs further testing.
 26. Attach documents and photos even to a model without vision (when a vision-model is set up separately).
 27. Transcribe voice messages from Telegram! (requires a powerful server with at least 2 cores, 2 GB RAM, and voice-api enabled)
 28. Convenient and fast creation of chat branches, plus regeneration with instructions.
 29. The bot suggests a command but you don't know what it does? Press the Review button and the Lite model assesses its risks.

---

## What is Chatter focused on?

### 1. Safe agent operations

 - Every server/PC action is allowed only with user approval. Exceptions: Yolo mode enabled, Allow Always, or "work in this folder". "Work in this folder" finds the nearest `.git` and suggests it as the default.
 - The agent never sees your SSH key or password: they are substituted automatically and stored encrypted. **DO NOT** give the agent your password, even if it asks. It has a separate command for creating a new user on the server!
 - On the desktop, you can selectively disable features for safety. You can forbid writing data while allowing reads only, disable subagents, internet, or PC commands. Or cut off its access to your memory entirely.
 - Email, SSH keys, and sensitive data are encrypted.
 - All admin panel API requests go through a reverse proxy and Chatter Manager, while repeated login attempts are automatically blocked.
 - Basic prompt injection protection is built in.
 - If you don't know what a command suggested by the neural network does, you press Review and another neural network explains it to you, assessing the risks.

    ![Checking command risks before execution](docs/assets/chatter-command-review.gif)

### 2. Relentless optimization

 - System prompts and other repeated context parts remain stable so the provider can cache up to 90–95% of input tokens.
 - Chats, photos, and messages are loaded dynamically to avoid overloading the DOM. Virtualization is not used (I hate it): instead, a load-more button and character-count-based calculation are used.
 - OpenRouter redirects you to different providers and breaks caching, and you don't want to dig in and configure keys? Just select a provider pulled directly from OpenRouter, and only that provider will be used.
 - You can enter multiple providers (OpenRouter/DeepSeek/Xiaomi/etc), and if the first one fails with an error, the task is immediately redirected to another.
 - No money to run a vision model every time? No problem. Add a vision model once, and your main AI bot will simply ask it to describe the image you attached.
 - No money for TTS but still want it? Local models are built in for that. Many external integrations also offer a free tier.
 - Don't want the AI generating utility code for itself over and over and burning tokens each time? Chatter's built-in tools are implemented in code ahead of time. Looks like a downside, right? But this way you can work on Chatter (if you want to) alongside subscriptions to major services, just by doing `git clone` on your computer.
 - The Desktop app in normal mode uses about 300 MB RAM and barely loads the CPU. Server containers are counted separately, while TTS and Whisper naturally require more resources. Codex itself can easily slow down and lag on my machine.
 - To avoid breaking caching, when context overflows, 50% of the conversation is archived (a short summarization for compression will be added in the future).
 - If a document doesn't fit, Chatter automatically trims its content, keeping up to 90% of the selected context limit.
 - A dedicated Lite model is used for generating chat titles, reviews, and other lightweight requests.

### 3. Convenience

 - Want to forward images or messages generated by the AI to your Telegram so they're on your phone? Press one button.
 - Want to improve a prompt? Press one button and apply the changes the AI suggests.
 - Don't want to fill in macros or write something in the notebook? Ask the AI to do it.
 - Don't want to search for your SSH key across your entire PC? Press one button :D
 - Left home and want to continue the conversation from your phone? All chats, prompt selection, and model choice are available right from Telegram!
 - Don't want to struggle and search for your API key again, pick a model on OpenRouter, or figure out how to parse the reasoning of a new model? API keys can be saved, models are pulled automatically and immediately show cost, context limits, and available providers to preserve caching! And DeepSeek and Xiaomi are coded in as third-party providers (if new ones like Mistral appear — write to me, I'll add them).
 - Don't want to manually calculate how much each model costs? OpenRouter fills in its own values, and there are presets for others.
 - Your users don't want to bother figuring out model choices? Auto mode is always there!
 - All integrations will later get descriptions and quick-start guides. These already exist for the smart home integration.

### 4. Customization

 - Parameters of each model can be configured. Temperature, Top P, and others.
 - Desktop app functionality can be disabled and customized.

---

## Translating the project to your language

Decided to translate the project into your language? It's quick and easy:

 1. Add your language to `shared/languages.ts` — this is the single source of truth for the language list across all components.
 2. Run:
    ```bash
    npm run sync:languages
    ```
    to update local copies of the list.
 3. Add your API key to `.env.i18n`:
    ```
    I18N_TRANSLATE_API_URL=url
    I18N_TRANSLATE_API_KEY=your_key
    I18N_TRANSLATE_MODEL=your_model
    ```
 4. Run:
    ```bash
    npm run i18n:translate:all
    ```
    This command will separately translate the Telegram bot, Desktop, Backend API, Webapp Notes, admin panel, and changelog files.
 5. Enjoy.

---

## Important

 - The service may contain bugs I haven't found yet. If you find one — submit it to Issues, we'll figure it out. The bugs I already know about are in the fix backlog. I'm working on the project alone, so help is welcome!
 - Future plans include refactoring both the desktop-app and the backend-api.
 - When using Chatter as a CLI for work, issues may still occur (e.g. it might confuse a string and not check types, leaving an error). I'm working on improving this.
 - **Security notice:** Chatter is under active development and has a large attack surface due to its integrations, remote-control tools, and self-hosted architecture. While security is treated as a priority, no software can be guaranteed to be completely secure. Review the configuration before exposing an instance to the internet, keep it updated, and report vulnerabilities responsibly. Security hardening will continue as the project evolves.

---

## License

Copyright (C) 2026 Nikita Cherepov.

Chatter is licensed under the [GNU Affero General Public License v3.0](LICENSE).
