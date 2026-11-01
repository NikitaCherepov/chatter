# Specialized agents

Each registered agent has a prompt in `prompts/` and a tool configuration in `registry.ts`.
Adding a Markdown file alone does not register a new agent.

Start the prompt with a flat metadata header:

```md
---
name_key: subagents.my_agent.name
description_key: subagents.my_agent.description
icon: file
---

# Role
Your system prompt goes here.
```

Add those keys to the **backend** dictionaries:
`src/i18n/locales/en/translation.json` and `src/i18n/locales/ru/translation.json`.
Other languages use the existing backend translation fallback until translated.
Then add the agent's registry entry with its ID, `promptFile`, tools and execution limits.
The metadata keys may use any existing backend dictionary path; they are not derived from the agent ID.

`GET /api/v1/subagents/catalog?language=ru` returns `{ agents: [{ id, name, description, icon }] }`.
An explicit supported language takes precedence over the account language; English is the final fallback.
The frontend displays the returned strings directly and does not maintain per-agent translations.
The header is stripped before the prompt is sent to a model. No prompt body, tools or dictionary keys are exposed in the catalog.

Prompts and parsed headers are cached together; `clearPromptCache()` clears both.
Dictionary files are loaded by the existing backend i18n initialization; restart the backend after editing them.
For legacy prompts without a header, the catalog falls back to the registry ID and description.

At startup the backend validates metadata keys against non-empty English dictionary strings and logs `[subagents]` warnings with the prompt filename and key. Missing translations keep the catalog fallback; they do not stop the entire server.

Optional `icon` names: `agent`, `search`, `file`, `code`, `terminal`, `globe`, `book`, `calendar`. Omit it to use `agent`. Unknown names are rendered as the default agent icon by older/newer clients; no per-agent ID mapping is needed. The icon set lives in `desktop-app/src/renderer/components/Icon.tsx`.
