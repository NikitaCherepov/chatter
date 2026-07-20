import type { Metadata } from 'next';
import { I18nProvider } from './I18nProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Chatter Admin',
  description: 'Self-hosted Chatter server management',
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
