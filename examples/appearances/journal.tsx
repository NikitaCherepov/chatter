import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Chat = {
  id: number;
  title: string;
  folderId: number | null;
  updatedAt: number;
};
type Message = { id: number; role: string; content: string; createdAt: number };
type State = {
  view: "home" | "conversation";
  activeChatId: number | null;
  chats: Chat[];
  folders: { id: number; name: string; count: number }[];
  sections: { folderId: number | null; hasMore: boolean; loading: boolean }[];
  messages: Message[];
  messagesLoading: boolean;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  sending: boolean;
  canSend: boolean;
  attachmentCount: number;
  query: string;
  loading: boolean;
  locale: string;
  labels: Record<string, string>;
};
type Bridge = {
  subscribe: (
    listener: (state: State) => void,
    options?: { navigation: boolean },
  ) => () => void;
  openChat: (id: number) => void;
  showHome: () => void;
  newChat: () => void;
  search: (query: string) => void;
  loadMore: (folderId: number | null) => void;
  sendMessage: (text: string) => boolean;
  stopGeneration: () => void;
  loadOlderMessages: () => void;
  openConversation: () => void;
  attachFiles: () => void;
};
const bridge = (window as unknown as { chatter: Bridge }).chatter;

const styles = `
:root {
  color-scheme: light;
}
html,
body,
#root {
  height: 100%;
  margin: 0;
}
* {
  box-sizing: border-box;
}
body {
  background: #f3efe5;
  color: #302b24;
  font:
    16px/1.65 Georgia,
    serif;
}
button,
input,
textarea {
  font: inherit;
}
button {
  cursor: pointer;
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid #9c492f;
  outline-offset: 4px;
}
button {
  background: transparent;
  border: 0;
  color: inherit;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(ellipse at 5% 10%, #fffaf1, transparent 70%), #f3efe5;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 36px;
  border-bottom: 2px solid #3e362b;
}
.wordmark {
  font:
    500 13px/1.5 system-ui,
    sans-serif;
  letter-spacing: 0.17em;
}
.actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.action {
  font:
    13px/1.5 system-ui,
    sans-serif;
  padding: 7px 0;
  color: #94462d;
  border-bottom: 1px solid transparent;
}
.action:hover {
  border-bottom-color: #94462d;
}
.home {
  padding: 35px 5vw 45px;
  overflow: auto;
  min-height: 0;
  flex: 1;
}
.home-title {
  font-size: clamp(32px, 5.5vw, 65px);
  line-height: 1.1;
  font-weight: 400;
  letter-spacing: -0.05em;
  margin: 0 0 27px;
}
.utility {
  display: flex;
  gap: 20px;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
  padding-bottom: 17px;
  border-bottom: 1px solid #cbbfae;
}
.search {
  background: none;
  border: 0;
  border-bottom: 1px solid #cbbfae;
  padding: 8px 0;
  width: 230px;
  max-width: 60%;
  color: #302b24;
  font:
    14px system-ui,
    sans-serif;
}
.collection {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 45px;
}
.feature {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  gap: 22px;
  text-align: left;
  min-height: 330px;
  border-right: 1px solid #cbbfae;
  padding: 0 35px 10px 0;
}
.feature h2 {
  font-size: clamp(30px, 4vw, 48px);
  font-weight: 400;
  line-height: 1.13;
  letter-spacing: -0.03em;
  overflow-wrap: anywhere;
  margin: 14px 0;
}
.eyebrow {
  font:
    11px/1.6 system-ui,
    sans-serif;
  letter-spacing: 0.08em;
  color: #786e5f;
}
.read {
  font-style: italic;
  color: #94462d;
}
.entries {
  display: flex;
  flex-direction: column;
}
.entry {
  text-align: left;
  border-top: 1px solid #cbbfae;
  padding: 18px 0;
}
.entry:first-child {
  border-top: 0;
  padding-top: 0;
}
.entry h2 {
  font-size: 22px;
  line-height: 1.3;
  font-weight: 400;
  margin: 7px 0;
  overflow-wrap: anywhere;
}
.feature:hover h2,
.entry:hover h2 {
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 6px;
}
.footer {
  margin-top: 30px;
  border-top: 1px solid #cbbfae;
  padding-top: 15px;
  font:
    12px/1.5 system-ui,
    sans-serif;
  color: #786e5f;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.reading {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: 210px 1fr;
}
.contents {
  padding: 30px 23px;
  border-right: 1px solid #cbbfae;
  overflow: auto;
}
.contents button {
  display: block;
  text-align: left;
  width: 100%;
  padding: 12px 0;
  font-size: 14px;
  border-bottom: 1px solid #dcd2c3;
  overflow-wrap: anywhere;
}
.contents button[aria-current="true"] {
  color: #94462d;
  font-style: italic;
}
.page {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.scroll {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 30px max(24px, calc((100% - 650px) / 2));
  scrollbar-width: thin;
  scrollbar-color: #cbbfae transparent;
}
.page-title {
  font-size: clamp(28px, 3.5vw, 40px);
  font-weight: 400;
  line-height: 1.2;
  letter-spacing: -0.035em;
  margin: 8px 0 36px;
  overflow-wrap: anywhere;
}
.passage {
  margin-bottom: 30px;
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}
.passage.user {
  border-left: 2px solid #af7962;
  padding-left: 20px;
  font-style: italic;
}
.passage p {
  margin: 0 0 13px;
}
.passage p:last-child {
  margin: 0;
}
.passage h1,
.passage h2,
.passage h3 {
  line-height: 1.3;
  font-weight: 400;
}
.passage .byline {
  font:
    11px/1.5 system-ui,
    sans-serif;
  letter-spacing: 0.1em;
  color: #786e5f;
  margin-bottom: 10px;
  font-style: normal;
}
.passage pre {
  white-space: pre-wrap;
  background: #e9e2d5;
  padding: 16px;
  font: 13px/1.6 monospace;
  overflow-wrap: anywhere;
}
.passage code {
  font-size: 0.9em;
}
.passage blockquote {
  border-left: 1px solid #b9ab94;
  margin-left: 0;
  padding-left: 20px;
}
.passage table {
  display: block;
  overflow: auto;
  font-size: 14px;
}
.markdown-link {
  color: #94462d;
  text-decoration: underline;
  text-underline-offset: 3px;
  padding: 0;
}
.compose {
  display: flex;
  align-items: flex-end;
  gap: 18px;
  border-top: 1px solid #cbbfae;
  background: #f3efe5;
  padding: 17px max(24px, calc((100% - 650px) / 2)) 24px;
}
.compose textarea {
  min-width: 0;
  flex: 1;
  resize: vertical;
  min-height: 58px;
  max-height: 140px;
  border: 0;
  border-bottom: 1px solid #b8a98f;
  background: transparent;
  color: #302b24;
  padding: 8px 0;
}
.compose textarea::placeholder {
  color: #857763;
}
.compose .actions {
  gap: 12px;
  flex-shrink: 0;
}
.status {
  color: #786e5f;
  font-style: italic;
}
@media (max-width: 650px) {
  .header {
    padding: 16px 20px;
    align-items: flex-start;
  }
  .actions {
    gap: 12px;
  }
  .home {
    padding: 25px 22px;
  }
  .collection {
    grid-template-columns: 1fr;
    gap: 22px;
  }
  .feature {
    border-right: 0;
    border-bottom: 1px solid #cbbfae;
    min-height: 220px;
    padding: 0 0 24px;
  }
  .reading {
    grid-template-columns: 1fr;
  }
  .contents {
    display: none;
  }
  .scroll {
    padding: 25px 22px;
  }
  .compose {
    padding: 14px 20px;
    gap: 14px;
  }
  .compose .actions {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }
  .wordmark {
    font-size: 11px;
    letter-spacing: 0.1em;
  }
  .utility {
    gap: 15px;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .page-title {
    animation: ink 0.3s ease-out;
  }
  @keyframes ink {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
}
`;

export default function Journal() {
  const [state, setState] = useState<State | null>(null);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousChat = useRef<number | null>(null);
  useEffect(() => bridge.subscribe(setState, { navigation: true }), []);
  useEffect(() => {
    if (!state || !viewport.current) return;
    if (previousChat.current !== state.activeChatId || follow.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
    previousChat.current = state.activeChatId;
  }, [state?.activeChatId, state?.messages]);
  if (!state)
    return (
      <>
        <style>{styles}</style>
        <div className="home">Открываем журнал…</div>
      </>
    );
  const ru = state.locale.startsWith("ru");
  const text = (russian: string, english: string) => (ru ? russian : english);
  const chats = [...state.chats].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.id - a.id,
  );
  const active = chats.find((chat) => chat.id === state.activeChatId);
  const pending = state.sections.find(
    (section) => section.hasMore && !section.loading,
  );
  const date = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleDateString(state.locale, {
      day: "numeric",
      month: "long",
    });
  const folder = (chat: Chat) =>
    state.folders.find((folder) => folder.id === chat.folderId)?.name ||
    text("Личное", "Personal");
  const draft = state.activeChatId ? drafts[state.activeChatId] || "" : "";
  const markdownComponents = {
    a: ({ children }: any) => (
      <button
        type="button"
        className="markdown-link"
        onClick={() => bridge.openConversation()}
      >
        {children} ↗
      </button>
    ),
    img: ({ alt }: any) => (
      <button
        type="button"
        className="markdown-link"
        onClick={() => bridge.openConversation()}
      >
        {alt || text("Изображение", "Image")} ↗
      </button>
    ),
  };
  return (
    <div className="app">
      <style>{styles}</style>
      <header className="header">
        <div className="wordmark">
          {text("ЛИЧНЫЙ ЖУРНАЛ", "PRIVATE JOURNAL")}
        </div>
        <div className="actions">
          <button
            className="action"
            onClick={() =>
              state.view === "conversation"
                ? bridge.showHome()
                : bridge.newChat()
            }
          >
            {state.view === "conversation"
              ? text("← К записям", "← All entries")
              : state.labels.newChat}
          </button>
        </div>
      </header>
      {state.view === "home" ? (
        <main className="home" data-example-home>
          <h1 className="home-title">{text("Разговоры.", "Conversations.")}</h1>
          <div className="utility">
            <span className="eyebrow">
              {text("НЕДАВНИЕ ЗАПИСИ", "RECENT ENTRIES")}
            </span>
            <input
              className="search"
              type="search"
              maxLength={200}
              value={query}
              placeholder={state.labels.search}
              onChange={(event) => {
                setQuery(event.target.value);
                bridge.search(event.target.value);
              }}
            />
          </div>
          {!chats.length ? (
            <p className="status">
              {state.loading ? state.labels.loading : state.labels.empty}
            </p>
          ) : (
            <div className="collection">
              <button
                type="button"
                className="feature"
                data-chat-id={chats[0].id}
                onClick={() => bridge.openChat(chats[0].id)}
              >
                <div>
                  <span className="eyebrow">
                    {folder(chats[0])} · {date(chats[0].updatedAt)}
                  </span>
                  <h2>{chats[0].title}</h2>
                </div>
                <span className="read">
                  {text("Продолжить разговор ↗", "Continue reading ↗")}
                </span>
              </button>
              <div className="entries">
                {chats.slice(1).map((chat) => (
                  <button
                    type="button"
                    className="entry"
                    key={chat.id}
                    data-chat-id={chat.id}
                    onClick={() => bridge.openChat(chat.id)}
                  >
                    <span className="eyebrow">
                      {date(chat.updatedAt)} · {folder(chat)}
                    </span>
                    <h2>{chat.title}</h2>
                  </button>
                ))}
              </div>
            </div>
          )}
          <footer className="footer">
            <span>{text("Сохранено в Chatter", "Stored in Chatter")}</span>
            {pending && state.query.trim().length < 3 && (
              <button
                className="action"
                onClick={() => bridge.loadMore(pending.folderId)}
              >
                {state.labels.loadMore} ↓
              </button>
            )}
          </footer>
        </main>
      ) : (
        <div className="reading">
          <aside className="contents" aria-label={state.labels.allChats}>
            <div className="eyebrow">{text("СОДЕРЖАНИЕ", "CONTENTS")}</div>
            {chats.map((chat) => (
              <button
                type="button"
                key={chat.id}
                aria-current={chat.id === state.activeChatId}
                onClick={() => bridge.openChat(chat.id)}
              >
                {chat.title}
              </button>
            ))}
          </aside>
          <main className="page">
            <div
              className="scroll"
              ref={viewport}
              onScroll={() => {
                const element = viewport.current!;
                follow.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  100;
              }}
            >
              <span className="eyebrow">
                {text("ПЕРЕПИСКА", "CORRESPONDENCE")}
              </span>
              <h1 className="page-title">
                {active?.title || text("Новая запись", "New entry")}
              </h1>
              {state.hasOlderMessages && (
                <button
                  className="action"
                  disabled={state.olderMessagesLoading}
                  onClick={() => bridge.loadOlderMessages()}
                >
                  {text("Предыдущие страницы ↑", "Previous pages ↑")}
                </button>
              )}
              {state.messagesLoading ? (
                <p className="status">{state.labels.loading}</p>
              ) : (
                state.messages
                  .filter((message) => message.content.trim())
                  .map((message) => (
                    <article
                      key={message.id}
                      className={"passage " + message.role}
                    >
                      <div className="byline">
                        {message.role === "user"
                          ? text("ВЫ", "YOU")
                          : text("СОБЕСЕДНИК", "ASSISTANT")}{" "}
                        · {date(message.createdAt)}
                      </div>
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                      >
                        {message.content}
                      </Markdown>
                    </article>
                  ))
              )}
              {state.sending && (
                <p className="status">
                  {text(
                    "Ответ ещё пишется…",
                    "The reply is still being written…",
                  )}
                </p>
              )}
            </div>
            <form
              className="compose"
              onSubmit={(event) => {
                event.preventDefault();
                if (state.sending) {
                  bridge.stopGeneration();
                  return;
                }
                if (draft.trim() && bridge.sendMessage(draft))
                  setDrafts((previous) => ({
                    ...previous,
                    [state.activeChatId!]: "",
                  }));
              }}
            >
              <textarea
                aria-label={text("Сообщение", "Message")}
                value={draft}
                rows={2}
                maxLength={100000}
                disabled={!state.canSend}
                placeholder={text(
                  "Продолжить разговор…",
                  "Continue the conversation…",
                )}
                onChange={(event) =>
                  setDrafts((previous) => ({
                    ...previous,
                    [state.activeChatId!]: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="actions">
                <button
                  type="submit"
                  className="action"
                  disabled={!state.sending && (!state.canSend || !draft.trim())}
                >
                  {state.sending
                    ? text("Остановить", "Stop")
                    : text("Отправить ↗", "Send ↗")}
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={() => bridge.attachFiles()}
                >
                  {text("Вложение", "Attach")}
                  {state.attachmentCount ? " · " + state.attachmentCount : ""}
                </button>
              </div>
            </form>
          </main>
        </div>
      )}
    </div>
  );
}
