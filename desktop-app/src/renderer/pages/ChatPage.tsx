import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { LinkTelegramModal } from '../components/LinkTelegramModal';

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

  useEffect(() => {
    loadChats();
  }, []);

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
    try {
      await api.activateChat(chatId);
    } catch {}
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
      id: -Date.now(),
      role: 'user',
      content: text,
      created_at: Math.floor(Date.now() / 1000),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await api.sendChatMessage(text);
      const assistantMsg: api.Message = {
        id: res.message_id,
        role: 'assistant',
        content: res.reply_text,
        created_at: Math.floor(Date.now() / 1000),
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div style={styles.layout}>
      {/* Sidebar */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <span style={styles.logo}>Chatter</span>
          <button style={styles.newChatBtn} onClick={handleCreateChat}>+ New</button>
        </div>

        <div style={styles.chatList}>
          {chats.map((chat) => (
            <div
              key={chat.id}
              style={{
                ...styles.chatItem,
                ...(chat.id === activeChatId ? styles.chatItemActive : {}),
              }}
              onClick={() => selectChat(chat.id)}
            >
              {chat.title}
            </div>
          ))}
          {chats.length === 0 && (
            <div style={styles.emptyChats}>No chats yet</div>
          )}
        </div>

        <div style={styles.sidebarFooter}>
          <span style={styles.userName}>{user?.name || user?.username || 'User'}</span>
          <div style={styles.footerBtns}>
            <button style={styles.linkBtn} onClick={() => setShowLinkModal(true)}>Link TG</button>
            <button style={styles.logoutBtn} onClick={handleLogout}>Logout</button>
          </div>
        </div>
      </div>

      {/* Chat area */}
      <div style={styles.chatArea}>
        {!activeChatId ? (
          <div style={styles.emptyState}>
            <p style={styles.emptyStateText}>Select a chat or create a new one</p>
          </div>
        ) : (
          <>
            <div style={styles.messages}>
              {loadingMessages && <div style={styles.loading}>Loading...</div>}
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    ...styles.messageRow,
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  <div
                    style={{
                      ...styles.bubble,
                      ...(msg.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant),
                    }}
                  >
                    <div style={styles.bubbleText}>{msg.content}</div>
                    <div style={styles.bubbleTime}>{formatTime(msg.created_at)}</div>
                  </div>
                </div>
              ))}
              {sending && (
                <div style={{ ...styles.messageRow, justifyContent: 'flex-start' }}>
                  <div style={{ ...styles.bubble, ...styles.bubbleAssistant }}>
                    <div style={styles.typing}>Thinking...</div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div style={styles.inputArea}>
              <textarea
                style={styles.textarea}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                rows={1}
                disabled={sending}
              />
              <button
                style={{
                  ...styles.sendBtn,
                  opacity: sending ? 0.5 : 1,
                }}
                onClick={handleSend}
                disabled={sending || !input.trim()}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>

      {showLinkModal && (
        <LinkTelegramModal
          onClose={() => setShowLinkModal(false)}
          onLinked={() => { setShowLinkModal(false); loadChats(); }}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    height: '100vh',
    backgroundColor: '#1a1a2e',
    color: '#eee',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  sidebar: {
    width: 260,
    minWidth: 260,
    backgroundColor: '#0f3460',
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid #1a3a6a',
  },
  sidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px',
    borderBottom: '1px solid #1a3a6a',
  },
  logo: {
    fontSize: 18,
    fontWeight: 700,
    color: '#e94560',
  },
  newChatBtn: {
    padding: '4px 12px',
    borderRadius: 6,
    border: '1px solid #e94560',
    backgroundColor: 'transparent',
    color: '#e94560',
    cursor: 'pointer',
    fontSize: 13,
  },
  chatList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px',
  },
  chatItem: {
    padding: '10px 12px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 14,
    color: '#ccc',
    marginBottom: 2,
    transition: 'background-color 0.15s',
  },
  chatItemActive: {
    backgroundColor: '#1a3a6a',
    color: '#fff',
  },
  emptyChats: {
    padding: '16px',
    color: '#667',
    fontSize: 13,
    textAlign: 'center' as const,
  },
  sidebarFooter: {
    padding: '12px 16px',
    borderTop: '1px solid #1a3a6a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  userName: {
    fontSize: 13,
    color: '#8899aa',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  logoutBtn: {
    padding: '4px 10px',
    borderRadius: 6,
    border: 'none',
    backgroundColor: '#2a2a4a',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: 12,
  },
  linkBtn: {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid #e94560',
    backgroundColor: 'transparent',
    color: '#e94560',
    cursor: 'pointer',
    fontSize: 12,
  },
  footerBtns: {
    display: 'flex',
    gap: 6,
  },
  chatArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyStateText: {
    color: '#556',
    fontSize: 16,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  loading: {
    color: '#667',
    fontSize: 13,
    textAlign: 'center' as const,
    padding: 12,
  },
  messageRow: {
    display: 'flex',
  },
  bubble: {
    maxWidth: '70%',
    padding: '10px 14px',
    borderRadius: 12,
    fontSize: 14,
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  bubbleUser: {
    backgroundColor: '#e94560',
    color: '#fff',
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: '#16213e',
    color: '#ddd',
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    whiteSpace: 'pre-wrap',
  },
  bubbleTime: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 4,
    textAlign: 'right' as const,
  },
  typing: {
    color: '#8899aa',
    fontStyle: 'italic',
  },
  inputArea: {
    display: 'flex',
    gap: 8,
    padding: '12px 20px 16px',
    borderTop: '1px solid #1a3a6a',
  },
  textarea: {
    flex: 1,
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid #2a3a5e',
    backgroundColor: '#0f3460',
    color: '#eee',
    fontSize: 14,
    fontFamily: 'inherit',
    resize: 'none',
    outline: 'none',
    minHeight: 40,
    maxHeight: 120,
  },
  sendBtn: {
    padding: '10px 20px',
    borderRadius: 10,
    border: 'none',
    backgroundColor: '#e94560',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    alignSelf: 'flex-end',
  },
};
