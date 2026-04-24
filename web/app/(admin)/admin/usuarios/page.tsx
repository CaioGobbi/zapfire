'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Search, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface UsersResponse {
  ok: boolean;
  users: Array<{
    id: string;
    email: string;
    fullName: string;
    role: 'CUSTOMER' | 'AFFILIATE' | 'ADMIN';
    isActive: boolean;
    emailVerified: boolean;
    createdAt: string;
    lastLoginAt: string | null;
    _count: { keys: number; subscriptions: number };
  }>;
  nextCursor: string | null;
}

const ROLE_BADGE: Record<string, 'default' | 'secondary' | 'outline'> = {
  ADMIN: 'default',
  AFFILIATE: 'secondary',
  CUSTOMER: 'outline',
};

export default function AdminUsersPage() {
  const [items, setItems] = useState<UsersResponse['users']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);

  const loadPage = useCallback(async (q: string, cursor: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set('search', q);
    params.set('limit', '30');
    if (cursor) params.set('cursor', cursor);
    const res = await apiGet<UsersResponse>(`/admin/users?${params.toString()}`);
    setItems((prev) => (cursor ? [...prev, ...res.users] : res.users));
    setNextCursor(res.nextCursor);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try { await loadPage(search, null); } catch (err) { console.error(err); }
      finally { setLoading(false); }
    })();
  }, [search, loadPage]);

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput.trim());
  }

  async function onLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try { await loadPage(search, nextCursor); } catch (err) { console.error(err); }
    finally { setLoadingMore(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Usuários</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Busca por email, nome. Clique em uma linha pra ver detalhes e ações.
          </p>
        </div>
        <Button onClick={() => setGrantOpen(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          Liberar acesso
        </Button>
      </div>

      <form onSubmit={onSearchSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por email ou nome…"
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="outline">Buscar</Button>
        {search && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => { setSearch(''); setSearchInput(''); }}
          >
            Limpar
          </Button>
        )}
      </form>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {search ? `Resultados pra "${search}"` : 'Últimos usuários'}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <Skeleton className="h-64" />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {search ? 'Nenhum usuário encontrado.' : 'Sem usuários ainda.'}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead className="hidden md:table-cell">Nome</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="hidden sm:table-cell text-center">Chaves</TableHead>
                    <TableHead className="hidden lg:table-cell">Criado</TableHead>
                    <TableHead className="hidden lg:table-cell">Último login</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((u) => (
                    <TableRow key={u.id} className="cursor-pointer">
                      <TableCell colSpan={6} className="p-0">
                        <Link
                          href={`/admin/usuarios/${u.id}`}
                          className="grid grid-cols-[1fr_auto] md:grid-cols-[2fr_1fr_auto_auto] lg:grid-cols-[2fr_1.3fr_auto_50px_1fr_1fr] gap-3 items-center px-4 py-3 hover:bg-accent/30 transition-colors"
                        >
                          <span className="truncate">
                            <span className="text-foreground">{u.email}</span>
                            {!u.isActive && (
                              <span className="ml-2 text-xs text-destructive">[inativo]</span>
                            )}
                          </span>
                          <span className="hidden md:block text-muted-foreground truncate">
                            {u.fullName || '—'}
                          </span>
                          <Badge variant={ROLE_BADGE[u.role] || 'outline'}>{u.role}</Badge>
                          <span className="hidden sm:block text-center text-muted-foreground text-sm">
                            {u._count.keys}
                          </span>
                          <span className="hidden lg:block text-muted-foreground text-xs">
                            {formatDateTime(u.createdAt)}
                          </span>
                          <span className="hidden lg:block text-muted-foreground text-xs">
                            {formatDateTime(u.lastLoginAt)}
                          </span>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {nextCursor && (
                <div className="mt-4 flex justify-center">
                  <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
                    {loadingMore ? 'Carregando…' : 'Carregar mais'}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <GrantAccessDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        onDone={() => {
          setGrantOpen(false);
          // Recarrega a lista pra mostrar o user novo no topo
          loadPage(search, null).catch(() => {});
        }}
      />
    </div>
  );
}

// ============================================================
// GrantAccessDialog — fluxo completo de liberação de cortesia
// (UI versão do scripts/grant-access.js)
// ============================================================
interface GrantResponse {
  ok: boolean;
  userId: string;
  subscriptionId: string;
  keyValue: string;
  keyReused: boolean;
  userIsNew: boolean;
  magicLinkUrl: string | null;
  emailSent: boolean;
  emailMockMode: boolean;
}

function GrantAccessDialog({
  open, onOpenChange, onDone,
}: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [dias, setDias] = useState('365');
  const [planCode, setPlanCode] = useState<'monthly_v1' | 'annual_v1'>('monthly_v1');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GrantResponse | null>(null);

  function reset() {
    setEmail(''); setDias('365'); setPlanCode('monthly_v1');
    setNome(''); setSenha(''); setSendEmail(true);
    setResult(null); setBusy(false);
  }

  async function onSubmit() {
    if (!email.trim()) {
      toast.error('Email é obrigatório');
      return;
    }
    const diasNum = parseInt(dias, 10);
    if (!Number.isFinite(diasNum) || diasNum <= 0) {
      toast.error('Dias inválido');
      return;
    }
    if (senha && senha.length < 8) {
      toast.error('Senha precisa ter ao menos 8 caracteres');
      return;
    }
    setBusy(true);
    try {
      const res = await apiPost<GrantResponse>('/admin/grant-access', {
        email: email.trim(),
        dias: diasNum,
        planCode,
        nome: nome.trim() || undefined,
        senha: senha || undefined,
        sendEmail,
      });
      setResult(res);
      toast.success(res.userIsNew ? 'Usuário criado e acesso liberado' : 'Acesso liberado pra usuário existente');
      onDone();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Falha — veja console';
      toast.error(msg);
      console.error('[grant-access]', err);
    } finally {
      setBusy(false);
    }
  }

  function close(v: boolean) {
    onOpenChange(v);
    if (!v) reset();
  }

  // Após sucesso, mostra resumo (não o form)
  if (result) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Acesso liberado</DialogTitle>
            <DialogDescription>
              {result.userIsNew ? 'Novo usuário criado.' : 'Cortesia anexada a usuário existente.'}
              {result.keyReused && ' Chave existente reaproveitada (estende validade).'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <Label className="text-xs text-muted-foreground">Chave de acesso</Label>
              <code className="block mt-1 px-3 py-2 bg-muted rounded text-xs break-all font-mono">
                {result.keyValue}
              </code>
            </div>
            {result.magicLinkUrl && (
              <div>
                <Label className="text-xs text-muted-foreground">Magic link (válido 7d)</Label>
                <code className="block mt-1 px-3 py-2 bg-muted rounded text-xs break-all">
                  {result.magicLinkUrl}
                </code>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Email: {result.emailSent
                ? result.emailMockMode
                  ? '⚠ enviado em modo MOCK (RESEND_API_KEY vazio)'
                  : '✓ enviado'
                : '— pulado'}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>Fechar</Button>
            <Button onClick={() => { reset(); }}>Liberar outro</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Liberar acesso por cortesia</DialogTitle>
          <DialogDescription>
            Cria User (ou reusa se já existe) + Subscription manual + AccessKey.
            Não passa pela Kirvano, não cria Payment, não polui o MRR.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ga-email">Email *</Label>
            <Input
              id="ga-email" type="email" autoComplete="off" autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="cliente@exemplo.com"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ga-dias">Dias de acesso</Label>
              <Input
                id="ga-dias" type="number" min={1} max={3650}
                value={dias} onChange={(e) => setDias(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ga-plano">Plano</Label>
              <select
                id="ga-plano"
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value as 'monthly_v1' | 'annual_v1')}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="monthly_v1">Mensal (R$47)</option>
                <option value="annual_v1">Anual (R$395)</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ga-nome">Nome (opcional)</Label>
            <Input
              id="ga-nome" type="text" value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Derivado do email se vazio"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ga-senha">
              Senha direta <span className="text-muted-foreground text-xs">(opcional — pula magic link)</span>
            </Label>
            <Input
              id="ga-senha" type="text" value={senha} autoComplete="new-password"
              onChange={(e) => setSenha(e.target.value)}
              placeholder="Mín. 8 chars; entrega via WhatsApp"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
            <input
              type="checkbox" checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
            />
            <span>Enviar email automático (boas-vindas + chave + magic link se novo)</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={busy}>
            {busy ? 'Liberando…' : 'Liberar acesso'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
