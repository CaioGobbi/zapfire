'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Search, Key } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiGet } from '@/lib/api';
import { formatDate, formatKey } from '@/lib/format';

interface KeysResponse {
  ok: boolean;
  keys: Array<{
    id: string;
    keyValue: string;
    label: string;
    boundPhone: string | null;
    status: 'ACTIVE' | 'SUSPENDED' | 'BLOCKED' | 'EXPIRED';
    blockedReason: string | null;
    lastUsedAt: string | null;
    createdAt: string;
    user: { id: string; email: string; fullName: string };
    subscription: { status: string; currentPeriodEnd: string; plan: { code: string; name: string } };
  }>;
  nextCursor: string | null;
}

const STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  SUSPENDED: 'secondary',
  BLOCKED: 'destructive',
  EXPIRED: 'destructive',
};

export default function AdminKeysPage() {
  const [items, setItems] = useState<KeysResponse['keys']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (q: string, st: string, cursor: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set('search', q);
    if (st) params.set('status', st);
    params.set('limit', '30');
    if (cursor) params.set('cursor', cursor);
    const res = await apiGet<KeysResponse>(`/admin/keys?${params.toString()}`);
    setItems((prev) => (cursor ? [...prev, ...res.keys] : res.keys));
    setNextCursor(res.nextCursor);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try { await loadPage(search, status, null); } catch (err) { console.error(err); }
      finally { setLoading(false); }
    })();
  }, [search, status, loadPage]);

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput.trim());
  }

  async function onLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try { await loadPage(search, status, nextCursor); } catch (err) { console.error(err); }
    finally { setLoadingMore(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Chaves</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Busca por prefixo da chave hex, email do dono ou label.
        </p>
      </div>

      <form onSubmit={onSearchSubmit} className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Prefixo hex, email ou label…"
            className="pl-9"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Qualquer status</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="BLOCKED">BLOCKED</option>
          <option value="SUSPENDED">SUSPENDED</option>
          <option value="EXPIRED">EXPIRED</option>
        </select>
        <Button type="submit" variant="outline">Buscar</Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="w-4 h-4 text-zf-accent" /> Chaves cadastradas
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <Skeleton className="h-64" />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma chave encontrada.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chave</TableHead>
                    <TableHead className="hidden md:table-cell">Dono</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Plano</TableHead>
                    <TableHead className="hidden lg:table-cell">Vence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/admin/usuarios/${k.user.id}`} className="text-zf-accent hover:underline">
                          {formatKey(k.keyValue.slice(0, 16))}…
                        </Link>
                        <div className="text-muted-foreground text-xs mt-0.5">{k.label}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div>{k.user.email}</div>
                        <div className="text-xs text-muted-foreground">{k.user.fullName}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[k.status] || 'outline'}>{k.status}</Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {k.subscription?.plan?.name || '—'}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground text-xs">
                        {k.subscription?.currentPeriodEnd ? formatDate(k.subscription.currentPeriodEnd) : '—'}
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
    </div>
  );
}
