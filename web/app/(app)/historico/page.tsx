'use client';

import { useEffect, useState, useCallback } from 'react';
import { Receipt, ShieldCheck } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { apiGet } from '@/lib/api';
import { formatBRL, formatDateTime } from '@/lib/format';

// ============================================================
// Types
// ============================================================
interface PaymentsResponse {
  ok: boolean;
  payments: Array<{
    id: string;
    gatewayProvider: string;
    paidAmountCents: number;
    status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'CHARGEBACK';
    paymentMethod: string | null;
    paidAt: string | null;
    createdAt: string;
    nfIssued: boolean;
  }>;
  nextCursor: string | null;
}

interface ValidationsResponse {
  ok: boolean;
  validations: Array<{
    id: string;
    result: 'SUCCESS' | 'INVALID_KEY' | 'WRONG_PHONE' | 'EXPIRED' | 'BLOCKED' | 'DEVICE_LIMIT';
    reason: string | null;
    phoneTry: string | null;
    ipAddress: string;
    userAgent: string | null;
    createdAt: string;
  }>;
}

const PAY_STATUS: Record<string, { text: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }> = {
  PAID:       { text: 'Pago',        variant: 'default' },
  PENDING:    { text: 'Pendente',    variant: 'outline' },
  FAILED:     { text: 'Falhou',      variant: 'destructive' },
  REFUNDED:   { text: 'Reembolsado', variant: 'secondary' },
  CHARGEBACK: { text: 'Chargeback',  variant: 'destructive' },
};

const VAL_RESULT: Record<string, { text: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }> = {
  SUCCESS:      { text: 'OK',              variant: 'default' },
  INVALID_KEY:  { text: 'Chave inválida',  variant: 'destructive' },
  WRONG_PHONE:  { text: 'Número errado',   variant: 'destructive' },
  EXPIRED:      { text: 'Expirada',        variant: 'destructive' },
  BLOCKED:      { text: 'Bloqueada',       variant: 'destructive' },
  DEVICE_LIMIT: { text: 'Limite devices',  variant: 'destructive' },
};

// ============================================================
export default function HistoricoPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Histórico</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Pagamentos e tentativas de login da sua chave na extensão.
        </p>
      </div>

      <Tabs defaultValue="payments">
        <TabsList>
          <TabsTrigger value="payments" className="gap-2">
            <Receipt className="w-4 h-4" /> Pagamentos
          </TabsTrigger>
          <TabsTrigger value="validations" className="gap-2">
            <ShieldCheck className="w-4 h-4" /> Validações
          </TabsTrigger>
        </TabsList>
        <TabsContent value="payments" className="mt-4">
          <PaymentsTable />
        </TabsContent>
        <TabsContent value="validations" className="mt-4">
          <ValidationsTable />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
function PaymentsTable() {
  const [items, setItems] = useState<PaymentsResponse['payments']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (cursor: string | null) => {
    const url = `/account/payments?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await apiGet<PaymentsResponse>(url);
    setItems((prev) => (cursor ? [...prev, ...res.payments] : res.payments));
    setNextCursor(res.nextCursor);
  }, []);

  useEffect(() => {
    (async () => {
      try { await loadPage(null); } catch (err) { console.error(err); }
      finally { setLoading(false); }
    })();
  }, [loadPage]);

  async function onLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try { await loadPage(nextCursor); } catch (err) { console.error(err); }
    finally { setLoadingMore(false); }
  }

  if (loading) return <Skeleton className="h-64" />;

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Nenhum pagamento registrado ainda.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pagamentos</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Valor</TableHead>
              <TableHead className="hidden sm:table-cell">Método</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">NF</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => {
              const st = PAY_STATUS[p.status] || { text: p.status, variant: 'outline' as const };
              return (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(p.paidAt || p.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium">
                    {formatBRL(p.paidAmountCents)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground capitalize">
                    {p.paymentMethod?.toLowerCase().replace('_', ' ') || '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={st.variant}>{st.text}</Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">
                    {p.nfIssued ? 'Emitida' : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {nextCursor && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? 'Carregando…' : 'Carregar mais'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
function ValidationsTable() {
  const [items, setItems] = useState<ValidationsResponse['validations']>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<ValidationsResponse>('/account/validations?limit=50');
        setItems(res.validations);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Skeleton className="h-64" />;

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Nenhuma validação registrada. Quando você usar a chave na extensão, o histórico aparece aqui.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Últimas tentativas de login da extensão
          <span className="text-muted-foreground font-normal text-sm ml-2">
            (50 mais recentes)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Resultado</TableHead>
              <TableHead className="hidden md:table-cell">IP</TableHead>
              <TableHead className="hidden lg:table-cell">Motivo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((v) => {
              const st = VAL_RESULT[v.result] || { text: v.result, variant: 'outline' as const };
              return (
                <TableRow key={v.id}>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(v.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={st.variant}>{st.text}</Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground font-mono text-xs">
                    {v.ipAddress || '—'}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground text-xs">
                    {v.reason || '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
