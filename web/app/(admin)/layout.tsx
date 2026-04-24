'use client';

import { ReactNode, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { ShieldAlert, LayoutDashboard, Users, Key, LogOut, ArrowLeft } from 'lucide-react';

import { useAuthStore } from '@/lib/authStore';
import { logout } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ============================================================
// Admin layout — gate duplo (auth + role=ADMIN)
// ============================================================
// Se user não é admin, mostra 403. Se não tem sessão, redireciona /login.
// Sidebar própria, separada do layout do assinante.
// ============================================================

const NAV = [
  { href: '/admin',          label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/usuarios', label: 'Usuários',  icon: Users },
  { href: '/admin/chaves',   label: 'Chaves',    icon: Key },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { hydrated, accessToken, user } = useAuthStore();

  useEffect(() => {
    if (hydrated && !accessToken) router.replace('/login');
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
  if (!accessToken) return null;

  // Gate de role — é ADMIN?
  if (user?.role !== 'ADMIN') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-lg bg-destructive/20 text-destructive flex items-center justify-center">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-semibold">Acesso restrito</h1>
          <p className="text-muted-foreground text-sm">
            Esta área é exclusiva pra administradores. Se você deveria ter
            acesso, peça pra outro admin promover sua conta.
          </p>
          <Button asChild variant="outline">
            <Link href="/dashboard">
              <ArrowLeft className="w-4 h-4 mr-2" /> Voltar pro painel
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid grid-cols-[240px_1fr]">
      <aside className="border-r border-border bg-card/30 flex flex-col">
        <div className="p-5 border-b border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-zf-accent text-white flex items-center justify-center font-bold">
            Z
          </div>
          <div>
            <div className="text-lg font-semibold leading-tight">Zapfire</div>
            <div className="text-[10px] tracking-[0.18em] font-semibold text-zf-accent uppercase">
              Admin
            </div>
          </div>
        </div>

        <nav className="flex-1 p-2">
          {NAV.map((item) => {
            const active =
              item.href === '/admin'
                ? pathname === '/admin'
                : pathname.startsWith(item.href);
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

        <div className="p-3 border-t border-border space-y-1">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Painel do assinante
          </Link>
          <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground truncate">
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

      <main className="p-8 max-w-6xl w-full">{children}</main>
    </div>
  );
}
