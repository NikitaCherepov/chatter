import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { LinkTelegramModal } from '../components/LinkTelegramModal';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import s from './ChatPage.module.scss';

export function ChatPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [chats, setChats] = useState<api.ChatInfo[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<api.Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadChats = async () => {
    try {
      const res = await api.getChats();
      setChats(res.chats);
      if (res.active_chat_id) {
        setActiveChatId(res.active_chat_id);
      } else if (res.chats.length > 0) {
        selectChat(res.chats[0].id);
      }
    } catch (err) {
      console.error('Failed to load chats:', err);
    }
  };

  useEffect(() => { loadChats(); }, []);

  useEffect(() => {
    if (activeChatId) loadMessages(activeChatId);
  }, [activeChatId]);

  const loadMessages = async (chatId: number) => {
    setLoadingMessages(true);
    try {
      const res = await api.getMessages(chatId, 100);
      setMessages(res.messages);
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoadingMessages(false);
    }
  };

  const selectChat = async (chatId: number) => {
    setActiveChatId(chatId);
    try { await api.activateChat(chatId); } catch {}
  };

  const handleCreateChat = async () => {
    try {
      const res = await api.createChat();
      await loadChats();
      selectChat(res.chat_id);
    } catch (err) {
      console.error('Failed to create chat:', err);
    }
  };

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    const tempUserMsg: api.Message = {
      id: -Date.now(), role: 'user', content: text, created_at: Math.floor(Date.now() / 1000),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await api.sendChatMessage(text);
      const assistantMsg: api.Message = {
        id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (!activeChatId || res.chat_id !== activeChatId) {
        setActiveChatId(res.chat_id);
        loadChats();
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
    } finally {
      setSending(false);
    }
  }, [input, sending, activeChatId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleLogout = () => { logout(); navigate('/login', { replace: true }); };

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className={s.layout}>
      {/* SIDEBAR */}
      <aside className={s.sidebar}>
        <div className={s.sidebarHeader}>
          <span className={s.sidebarTitle}>Recent Chats</span>
          <button className={s.newChatBtn} onClick={handleCreateChat}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="7" y1="1" x2="7" y2="13" />
              <line x1="1" y1="7" x2="13" y2="7" />
            </svg>
          </button>
        </div>

        <div className={s.chatList}>
          {chats.map((chat) => (
            <div
              key={chat.id}
              className={`${s.chatItem} ${chat.id === activeChatId ? s.chatItemActive : ''}`}
              onClick={() => selectChat(chat.id)}
            >
              <div className={s.chatItemTitle}>{chat.title || 'New Chat'}</div>
              <div className={s.chatItemTime}>{formatTime(chat.created_at)}</div>
            </div>
          ))}
          {chats.length === 0 && (
            <div className={s.emptyChats}>No chats yet</div>
          )}
        </div>

        <div className={s.sidebarFooter}>
          <div className={s.userInfo}>
            <div className={s.avatar}>
              {(user?.name || user?.username || 'U')[0].toUpperCase()}
            </div>
            <span className={s.userName}>{user?.name || user?.username || 'User'}</span>
          </div>
          <div className={s.footerBtns}>
            <button className={s.iconBtn} onClick={() => setShowLinkModal(true)} title="Link Telegram">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
            <button className={s.iconBtn} onClick={handleLogout} title="Logout">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className={s.main}>
        {!activeChatId ? (
          <div className={s.emptyState}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-placeholder)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className={s.emptyStateText}>Select a chat or create a new one</p>
          </div>
        ) : (
          <>
            <div className={s.messages}>
              {loadingMessages && (
                <div className={s.loadingRow}>Loading messages...</div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={s.messageGroup}>
                  <div className={s.metaRow}>
                    {msg.role === 'user' ? 'You' : 'Chatter'} &bull; {formatTime(msg.created_at)}
                  </div>
                  <div className={msg.role === 'user' ? s.bubbleUser : s.bubble}>
                    {msg.role === 'assistant'
                      ? <div className={s.bubbleText}><MarkdownRenderer content={msg.content} /></div>
                      : <div className={s.bubbleTextPlain}>{msg.content}</div>
                    }
                  </div>
                </div>
              ))}
              {sending && (
                <div className={s.messageGroup}>
                  <div className={s.metaRow}>Chatter &bull; typing...</div>
                  <div className={s.bubble}>
                    <div className={s.typingDots}>
                      <span className={s.dot} />
                      <span className={s.dot} />
                      <span className={s.dot} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className={s.inputArea}>
              <svg className={s.inputIcon} viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>

              <textarea
                ref={textareaRef}
                className={s.textarea}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your message..."
                rows={1}
                disabled={sending}
              />

              <svg
                className={sending || !input.trim() ? s.sendIconDisabled : s.sendIcon}
                onClick={() => { if (!sending && input.trim()) handleSend(); }}
                viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </div>
          </>
        )}
      </main>

      <button className={s.fab}>?</button>

      {showLinkModal && (
        <LinkTelegramModal
          onClose={() => setShowLinkModal(false)}
          onLinked={() => { setShowLinkModal(false); loadChats(); }}
        />
      )}
    </div>
  );
}
