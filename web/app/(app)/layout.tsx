'use client';

import { ReactNode, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { LayoutDashboard, CreditCard, Laptop, History, LogOut, ShieldAlert } from 'lucide-react';

import { useAuthStore } from '@/lib/authStore';
import { logout } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ============================================================
// Layout autenticado — sidebar fixa + área principal
// ============================================================
// Enquanto `hydrated` é false (ainda rodando bootstrapSession),
// mostra esqueleto. Se terminou e não tem accessToken, redireciona
// pro /login.
// ============================================================

const NAV = [
  { href: '/dashboard',    label: 'Dashboard',    icon: LayoutDashboard },
  { href: '/assinatura',   label: 'Assinatura',   icon: CreditCard },
  { href: '/dispositivos', label: 'Dispositivos', icon: Laptop },
  { href: '/historico',    label: 'Histórico',    icon: History },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { hydrated, accessToken, user } = useAuthStore();

  useEffect(() => {
    if (hydrated && !accessToken) {
      router.replace('/login');
    }
  }, [hydrated, accessToken, router]);

  async function onLogout() {
    await logout();
    router.replace('/login');
  }

  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Carregando…</div>
      </div>
    );
  }
  if (!accessToken) {
    // Render nada enquanto o redirect efetiva (evita flash de conteúdo)
    return null;
  }

  return (
    <div className="min-h-screen grid grid-cols-[220px_1fr]">
      {/* Sidebar */}
      <aside className="border-r border-border bg-card/30 flex flex-col">
        <div className="p-5 border-b border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-zf-accent text-white flex items-center justify-center font-bold">
            Z
          </div>
          <div className="text-lg font-semibold">Zapfire</div>
        </div>

        <nav className="flex-1 p-2">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/');
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                  active
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-border">
          {user?.role === 'ADMIN' && (
            <Link
              href="/admin"
              className="flex items-center gap-3 px-3 py-2 mb-2 rounded-md text-sm text-zf-accent hover:bg-zf-accent/10 transition-colors"
            >
              <ShieldAlert className="w-4 h-4" /> Backoffice admin
            </Link>
          )}
          <div className="px-2 pb-2 text-xs text-muted-foreground truncate">
            {user?.email}
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start gap-3 text-muted-foreground"
            onClick={onLogout}
          >
            <LogOut className="w-4 h-4" /> Sair
          </Button>
        </div>
      </aside>

      {/* Main */}
      <main className="p-8 max-w-5xl w-full">{children}</main>
    </div>
  );
}
