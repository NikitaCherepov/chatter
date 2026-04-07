import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Chatter Notes',
  description: 'Telegram Web App заметок',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
