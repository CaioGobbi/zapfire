import type { Metadata } from 'next';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/components/AuthProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zapfire — painel',
  description: 'Painel do assinante Zapfire',
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
