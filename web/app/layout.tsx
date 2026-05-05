import type { Metadata } from 'next';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/components/AuthProvider';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Zapfire — painel',
    template: '%s · Zapfire',
  },
  description: 'Gerencie sua assinatura, chave e dispositivos do Zapfire.',
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/icon.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <AuthProvider>
          {children}
          <Toaster
            position="top-center"
            theme="dark"
            toastOptions={{
              classNames: {
                toast:
                  'bg-card border-border text-foreground shadow-lg',
              },
            }}
          />
        </AuthProvider>
      </body>
    </html>
  );
}
