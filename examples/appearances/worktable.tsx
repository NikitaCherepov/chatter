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
  background: #eef1ed;
  color: #263a34;
  font:
    14px/1.6 "Segoe UI",
    system-ui,
    sans-serif;
}
button,
input,
textarea {
  font: inherit;
}
button {
  cursor: pointer;
  color: inherit;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 3px solid #287460;
  outline-offset: 4px;
}
.app {
  height: 100%;
  overflow: auto;
  background-color: #eef1ed;
  background-image: radial-gradient(#8c9d902a 0.8px, transparent 0.8px);
  background-size: 18px 18px;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 26px 4vw;
  background: #f8faf6;
  border-bottom: 1px solid #d8e0d7;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.mark {
  height: 24px;
  width: 24px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  transform: rotate(-8deg);
}
.mark i {
  background: #347560;
  border-radius: 3px;
}
.mark i:last-child {
  opacity: 0.3;
}
.control {
  border: 1px solid #c9d6cb;
  background: #f8faf6;
  border-radius: 10px;
  padding: 9px 15px;
}
.control:hover {
  background: #e5eee5;
}
.control.primary {
  background: #2e6856;
  color: #fff;
  border-color: #2e6856;
}
.top .actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.search {
  border: 1px solid #d3ddd3;
  border-radius: 10px;
  background: #fff;
  color: #263a34;
  padding: 9px 14px;
  width: 230px;
  min-width: 0;
}
.board {
  padding: 24px 4vw 28px;
  max-width: 1400px;
  margin: auto;
}
.board-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}
.board h1 {
  font-size: 34px;
  line-height: 1.2;
  letter-spacing: -0.045em;
  font-weight: 500;
  margin: 0;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 28px;
}
.filter {
  border: 0;
  border-radius: 20px;
  background: #dfe8dd;
  color: #4e6356;
  padding: 7px 14px;
  font-size: 12px;
}
.filter[aria-pressed="true"] {
  background: #2e6856;
  color: #fff;
}
.cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
  align-items: start;
}
.note {
  --note: #fff3cf;
  --tape: #d8b35f;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 200px;
  padding: 28px;
  text-align: left;
  border: 0;
  border-radius: 3px 3px 24px 3px;
  background: var(--note);
  box-shadow:
    0 6px 14px #263a3409,
    0 1px 1px #263a3414;
  transform: rotate(-1deg);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
  overflow: hidden;
}
.note:before {
  content: "";
  position: absolute;
  left: 24px;
  top: 0;
  width: 58px;
  height: 6px;
  background: var(--tape);
}
.note:nth-child(4n + 2) {
  --note: #e2e8fc;
  --tape: #9caad7;
  transform: rotate(1.1deg);
}
.note:nth-child(4n + 3) {
  --note: #e0eedf;
  --tape: #92b28b;
  transform: rotate(-0.5deg);
}
.note:nth-child(4n) {
  --note: #f8e0d7;
  --tape: #dca391;
  transform: rotate(0.8deg);
}
.note:first-child {
  grid-column: span 2;
  min-height: 230px;
  padding: 32px;
}
.note:hover {
  transform: rotate(0) translateY(-5px);
  box-shadow: 0 14px 30px #263a3415;
}
.note .folder {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #576c5e;
}
.note h2 {
  font-size: 23px;
  line-height: 1.25;
  letter-spacing: -0.025em;
  font-weight: 500;
  overflow-wrap: anywhere;
  margin: 24px 0;
}
.note:first-child h2 {
  font-size: 34px;
  max-width: 510px;
}
.note footer {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: #576c5e;
}
.note footer b {
  font-size: 20px;
  font-weight: 400;
}
.bottom {
  display: flex;
  justify-content: center;
  padding-top: 34px;
}
.dialog {
  width: min(780px, calc(100vw - 40px));
  height: min(680px, calc(100dvh - 48px));
  max-width: none;
  max-height: none;
  overflow: hidden;
  border: 1px solid #d0d9cb;
  border-radius: 16px;
  background: #fbfcf8;
  color: #263a34;
  padding: 0;
  box-shadow: 0 30px 100px #15322633;
}
.dialog::backdrop {
  background: #243f3640;
  backdrop-filter: blur(6px);
}
.dialog[open] {
  display: flex;
  flex-direction: column;
}
.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: #e3ecdf;
  border-bottom: 1px solid #d0d9cb;
  padding: 18px 24px;
}
.dialog-head h1 {
  font-size: 20px;
  line-height: 1.3;
  letter-spacing: -0.03em;
  margin: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.dialog-head .control {
  padding: 6px 12px;
  white-space: nowrap;
  font-size: 12px;
}
.transcript {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 26px;
  scrollbar-width: thin;
  scrollbar-color: #c1cdbf transparent;
}
.message {
  max-width: 88%;
  margin-bottom: 23px;
  content-visibility: auto;
  contain-intrinsic-size: auto 100px;
}
.message.user {
  margin-left: auto;
}
.meta {
  font-size: 11px;
  color: #708073;
  margin: 0 0 7px 3px;
}
.bubble {
  background: #edf2e8;
  border-radius: 15px 15px 15px 3px;
  padding: 14px 18px;
  overflow-wrap: anywhere;
}
.user .bubble {
  background: #dde8f4;
  border-radius: 15px 15px 3px 15px;
}
.bubble p {
  margin: 0 0 10px;
}
.bubble p:last-child {
  margin: 0;
}
.bubble h1,
.bubble h2,
.bubble h3 {
  font-size: 18px;
  line-height: 1.3;
}
.bubble code {
  font: 12px/1.5 monospace;
}
.bubble pre {
  white-space: pre-wrap;
  background: #dfe8d8;
  padding: 10px;
  border-radius: 6px;
}
.bubble table {
  display: block;
  overflow: auto;
}
.link {
  border: 0;
  background: none;
  color: #246649;
  text-decoration: underline;
  padding: 0;
}
.compose {
  border-top: 1px solid #dce3d7;
  padding: 15px 20px;
  background: #fbfcf8;
  display: flex;
  gap: 12px;
  align-items: flex-end;
}
.compose textarea {
  flex: 1;
  min-width: 0;
  min-height: 64px;
  max-height: 140px;
  resize: vertical;
  background: #f0f4eb;
  border: 1px solid #d8e0d2;
  color: #263a34;
  border-radius: 11px;
  padding: 11px 13px;
}
.compose .actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.compose .actions button {
  font-size: 12px;
  padding: 7px 11px;
}
.status {
  color: #708073;
  font-size: 12px;
  padding: 0 0 15px;
}
@media (max-width: 700px) {
  .top {
    padding: 18px 20px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .top .actions {
    width: 100%;
  }
  .search {
    flex: 1;
    width: auto;
  }
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  .note,
  .note:first-child {
    padding: 21px;
    min-height: 210px;
  }
  .note:first-child {
    grid-column: span 2;
  }
  .note:first-child h2 {
    font-size: 30px;
  }
  .note h2 {
    font-size: 21px;
  }
  .board {
    padding: 25px 22px;
  }
  .board h1 {
    font-size: 29px;
  }
  .dialog {
    width: calc(100vw - 24px);
    height: calc(100dvh - 28px);
  }
  .dialog-head {
    padding: 15px 18px;
  }
  .dialog-head h1 {
    font-size: 18px;
  }
  .transcript {
    padding: 20px;
  }
  .compose {
    padding: 12px;
  }
  .message {
    max-width: 95%;
  }
}
@media (max-width: 380px) {
  .cards {
    grid-template-columns: 1fr;
  }
  .note:first-child {
    grid-column: auto;
  }
  .note:first-child h2 {
    font-size: 26px;
  }
  .dialog-head {
    gap: 8px;
  }
  .dialog-head .control {
    padding: 6px 8px;
  }
  .compose {
    gap: 8px;
  }
  .compose .actions button {
    padding: 7px 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .note {
    transition: none;
  }
}
`;

export default function Worktable() {
  const [state, setState] = useState<State | null>(null);
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState<number | null | "all">("all");
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastChat = useRef<number | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => bridge.subscribe(setState, { navigation: true }), []);
  useEffect(() => {
    const panel = dialog.current;
    if (!panel || !state) return;
    if (state.view === "conversation" && !panel.open) panel.showModal();
    if (state.view === "home" && panel.open) {
      panel.close();
      trigger.current?.focus();
    }
  }, [state?.view]);
  useEffect(() => {
    const panel = transcript.current;
    if (!panel || !state) return;
    if (lastChat.current !== state.activeChatId || follow.current)
      panel.scrollTop = panel.scrollHeight;
    lastChat.current = state.activeChatId;
  }, [state?.activeChatId, state?.messages]);
  if (!state)
    return (
      <>
        <style>{styles}</style>
        <p>Открываем рабочий стол…</p>
      </>
    );
  const text = (russian: string, english: string) =>
    state.locale.startsWith("ru") ? russian : english;
  const chats = [...state.chats]
    .filter((chat) => folderId === "all" || chat.folderId === folderId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  const active = state.chats.find((chat) => chat.id === state.activeChatId);
  const pending = state.sections.find(
    (section) =>
      section.hasMore &&
      !section.loading &&
      (folderId === "all" || section.folderId === folderId),
  );
  const draft = state.activeChatId ? drafts[state.activeChatId] || "" : "";
  const date = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleDateString(state.locale, {
      day: "numeric",
      month: "short",
    });
  const markdownComponents = {
    a: ({ children }: any) => (
      <button
        className="link"
        type="button"
        onClick={() => bridge.openConversation()}
      >
        {children} ↗
      </button>
    ),
    img: ({ alt }: any) => (
      <button
        className="link"
        type="button"
        onClick={() => bridge.openConversation()}
      >
        {alt || text("Изображение", "Image")} ↗
      </button>
    ),
  };
  return (
    <div className="app">
      <style>{styles}</style>
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          {text("Рабочий стол", "Worktable")}
        </div>
        <div className="actions">
          <input
            type="search"
            className="search"
            value={query}
            maxLength={200}
            placeholder={state.labels.search}
            onChange={(event) => {
              setQuery(event.target.value);
              bridge.search(event.target.value);
            }}
          />
          <button className="control primary" onClick={() => bridge.newChat()}>
            {state.labels.newChat}
          </button>
        </div>
      </header>
      <main className="board" data-example-home>
        <div className="board-head">
          <h1>{text("Мои разговоры", "My conversations")}</h1>
        </div>
        <nav className="filters" aria-label={text("Папки", "Folders")}>
          <button
            className="filter"
            aria-pressed={folderId === "all"}
            onClick={() => setFolderId("all")}
          >
            {state.labels.allChats}
          </button>
          <button
            className="filter"
            aria-pressed={folderId === null}
            onClick={() => setFolderId(null)}
          >
            {text("Без папки", "Unfiled")}
          </button>
          {state.folders.map((folder) => (
            <button
              key={folder.id}
              className="filter"
              aria-pressed={folderId === folder.id}
              onClick={() => setFolderId(folder.id)}
            >
              {folder.name}
            </button>
          ))}
        </nav>
        {!chats.length ? (
          <p className="status">
            {state.loading ? state.labels.loading : state.labels.empty}
          </p>
        ) : (
          <div className="cards">
            {chats.map((chat) => (
              <button
                className="note"
                type="button"
                key={chat.id}
                data-chat-id={chat.id}
                onClick={(event) => {
                  trigger.current = event.currentTarget;
                  bridge.openChat(chat.id);
                }}
              >
                <span className="folder">
                  {state.folders.find((folder) => folder.id === chat.folderId)
                    ?.name || text("Личное", "Personal")}
                </span>
                <h2>{chat.title}</h2>
                <footer>
                  <span>{date(chat.updatedAt)}</span>
                  <b aria-hidden="true">↗</b>
                </footer>
              </button>
            ))}
          </div>
        )}
        {pending && state.query.trim().length < 3 && (
          <div className="bottom">
            <button
              className="control"
              onClick={() => bridge.loadMore(pending.folderId)}
            >
              {state.labels.loadMore}
            </button>
          </div>
        )}
      </main>
      <dialog
        ref={dialog}
        className="dialog"
        aria-labelledby="conversation-title"
        onCancel={(event) => {
          event.preventDefault();
          bridge.showHome();
        }}
      >
        <header className="dialog-head">
          <h1 id="conversation-title">
            {active?.title || text("Новый разговор", "New conversation")}
          </h1>
          <button
            className="control"
            type="button"
            onClick={() => bridge.showHome()}
          >
            {text("Закрыть ↗", "Close ↗")}
          </button>
        </header>
        <div
          className="transcript"
          ref={transcript}
          role="log"
          aria-label={text("Переписка", "Conversation")}
          onScroll={() => {
            const panel = transcript.current!;
            follow.current =
              panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
          }}
        >
          {state.hasOlderMessages && (
            <button
              className="link"
              disabled={state.olderMessagesLoading}
              onClick={() => bridge.loadOlderMessages()}
            >
              {text("Предыдущие сообщения ↑", "Earlier messages ↑")}
            </button>
          )}
          {state.messagesLoading ? (
            <p className="status">{state.labels.loading}</p>
          ) : (
            state.messages
              .filter((message) => message.content.trim())
              .map((message) => (
                <article className={"message " + message.role} key={message.id}>
                  <div className="meta">
                    {message.role === "user"
                      ? text("Вы", "You")
                      : text("Собеседник", "Assistant")}{" "}
                    · {date(message.createdAt)}
                  </div>
                  <div className="bubble">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {message.content}
                    </Markdown>
                  </div>
                </article>
              ))
          )}
          {state.sending && (
            <div className="status">
              {text("Пишет ответ…", "Writing a reply…")}
            </div>
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
            rows={2}
            maxLength={100000}
            aria-label={text("Сообщение", "Message")}
            disabled={!state.canSend}
            value={draft}
            placeholder={text("Что обсудим?", "What shall we discuss?")}
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
              className="control primary"
              disabled={!state.sending && (!state.canSend || !draft.trim())}
            >
              {state.sending ? text("Стоп", "Stop") : text("Отправить", "Send")}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => bridge.attachFiles()}
            >
              {text("Вложение", "Attach")}
              {state.attachmentCount ? " · " + state.attachmentCount : ""}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
