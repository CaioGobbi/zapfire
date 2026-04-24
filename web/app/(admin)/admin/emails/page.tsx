'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Mail, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface EmailsResponse {
  ok: boolean;
  emails: Array<{
    id: string;
    type: string;
    deliveryStatus: string | null;
    deliveryUpdatedAt: string | null;
    resendEmailId: string | null;
    usedAt: string | null;
    expiresAt: string;
    createdAt: string;
    user: { id: string; email: string; fullName: string };
  }>;
}

const STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  delivered: 'default',
  sent: 'secondary',
  bounced: 'destructive',
  complained: 'destructive',
  failed: 'destructive',
  delayed: 'outline',
};

const STATUS_LABELS: Record<string, string> = {
  sent: 'Enviado',
  delivered: 'Entregue',
  bounced: 'Bounce',
  complained: 'Spam',
  failed: 'Falhou',
  delayed: 'Atrasado',
};

const FILTERS = [
  { key: '',           label: 'Todos' },
  { key: 'bounced',    label: 'Bounces' },
  { key: 'complained', label: 'Spam' },
  { key: 'failed',     label: 'Falhou' },
  { key: 'delivered',  label: 'Entregues' },
  { key: 'sent',       label: 'Em trânsito' },
  { key: 'pending',    label: 'Sem status (mock ou sem webhook)' },
];

export default function AdminEmailsPage() {
  const [items, setItems] = useState<EmailsResponse['emails']>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (st: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (st) params.set('status', st);
      params.set('limit', '100');
      const res = await apiGet<EmailsResponse>(`/admin/emails?${params.toString()}`);
      setItems(res.emails);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(status); }, [status, load]);

  const bounceCount = items.filter((e) => ['bounced', 'complained', 'failed'].includes(e.deliveryStatus || '')).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Emails</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Status de entrega dos magic links enviados. Bounces indicam que o cliente
          provavelmente nunca recebeu o email pra configurar a senha.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={status === f.key ? 'default' : 'outline'}
            onClick={() => setStatus(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {!loading && bounceCount > 0 && status === '' && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0" />
            <div className="text-sm">
              <strong>{bounceCount}</strong> email(s) com problema de entrega nas últimas linhas.
              Clique no usuário pra ver detalhes e, se quiser, dispare um novo magic link pelo painel.
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="w-4 h-4 text-zf-type-text" />
            {status ? STATUS_LABELS[status] || status : 'Todos os emails'}
            <Badge variant="secondary" className="ml-auto">{items.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <Skeleton className="h-64" />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhum email nesse filtro.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Enviado em</TableHead>
                  <TableHead>Destinatário</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Consumido?</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDateTime(e.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Link href={`/admin/usuarios/${e.user.id}`} className="text-zf-accent hover:underline">
                        {e.user.email}
                      </Link>
                      {e.user.fullName && (
                        <div className="text-xs text-muted-foreground">{e.user.fullName}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{e.type}</Badge>
                    </TableCell>
                    <TableCell>
                      {e.deliveryStatus ? (
                        <Badge variant={STATUS_VARIANT[e.deliveryStatus] || 'outline'}>
                          {STATUS_LABELS[e.deliveryStatus] || e.deliveryStatus}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {e.usedAt ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-zf-success">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {formatDateTime(e.usedAt)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Não</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
