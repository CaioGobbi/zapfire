'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, CreditCard, Calendar, RefreshCw } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { apiGet } from '@/lib/api';
import { formatBRL, formatDate } from '@/lib/format';

interface SubscriptionResponse {
  ok: boolean;
  subscription: null | {
    id: string;
    status: 'ACTIVE' | 'CANCELED' | 'PAST_DUE' | 'EXPIRED' | 'BLOCKED' | 'PENDING';
    planCode: string;
    planName: string;
    priceCents: number;
    billingCycle: string;
    currentPeriodEnd: string;
    canceledAt: string | null;
    autoRenew: boolean;
    gatewayProvider: string;
    inGracePeriod: boolean;
    gracePeriodEndsAt: string | null;
    daysLeftGrace: number | null;
  };
}

interface PaymentsResponse {
  ok: boolean;
  payments: Array<{
    id: string;
    paidAmountCents: number;
    status: string;
    paymentMethod: string | null;
    paidAt: string | null;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

const STATUS_LABELS: Record<string, { text: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }> = {
  ACTIVE:   { text: 'Ativa',     variant: 'default' },
  CANCELED: { text: 'Cancelada', variant: 'secondary' },
  PAST_DUE: { text: 'Atrasada',  variant: 'destructive' },
  EXPIRED:  { text: 'Expirada',  variant: 'destructive' },
  BLOCKED:  { text: 'Bloqueada', variant: 'destructive' },
  PENDING:  { text: 'Pendente',  variant: 'outline' },
};

const BILLING_LABEL: Record<string, string> = {
  MONTHLY: 'Mensal',
  QUARTERLY: 'Trimestral',
  SEMIANNUAL: 'Semestral',
  ANNUAL: 'Anual',
  LIFETIME: 'Vitalício',
  PREPAID: 'Pré-pago',
};

const GATEWAY_PORTAL: Record<string, string | null> = {
  kirvano: 'https://kirvano.com/compras',
  manual: null,
};

export default function AssinaturaPage() {
  const [sub, setSub] = useState<SubscriptionResponse['subscription'] | null>(null);
  const [lastPayment, setLastPayment] = useState<PaymentsResponse['payments'][number] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [subRes, payRes] = await Promise.all([
          apiGet<SubscriptionResponse>('/account/subscription'),
          apiGet<PaymentsResponse>('/account/payments?limit=1'),
        ]);
        setSub(subRes.subscription);
        setLastPayment(payRes.payments[0] || null);
      } catch (err) {
        console.error('assinatura load', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Assinatura</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Dados do seu plano, vencimento e últimos pagamentos.
        </p>
      </div>

      {loading ? (
        <>
          <Skeleton className="h-48" />
          <Skeleton className="h-24" />
        </>
      ) : !sub ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Nenhuma assinatura ativa no momento.
          </CardContent>
        </Card>
      ) : (
        <>
          <PlanCard sub={sub} />
          <PaymentCard lastPayment={lastPayment} />
        </>
      )}
    </div>
  );
}

function PlanCard({ sub }: { sub: NonNullable<SubscriptionResponse['subscription']> }) {
  const st = STATUS_LABELS[sub.status] || { text: sub.status, variant: 'outline' as const };
  const portal = GATEWAY_PORTAL[sub.gatewayProvider] || null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-lg flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-zf-type-text" /> {sub.planName}
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {formatBRL(sub.priceCents)}
            {sub.billingCycle !== 'LIFETIME' && ` / ${BILLING_LABEL[sub.billingCycle] || sub.billingCycle}`}
          </p>
        </div>
        <Badge variant={st.variant}>{st.text}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <Separator />
        <div className="grid gap-4 sm:grid-cols-3 text-sm">
          <Row label={sub.status === 'CANCELED' ? 'Ativa até' : 'Próxima cobrança'}>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">{formatDate(sub.currentPeriodEnd)}</span>
            </div>
          </Row>
          <Row label="Renovação">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-muted-foreground" />
              <span>{sub.autoRenew ? 'Automática' : 'Manual'}</span>
            </div>
          </Row>
          <Row label="Gateway">
            <span className="capitalize">{sub.gatewayProvider}</span>
          </Row>
        </div>

        {sub.status === 'CANCELED' && (
          <div className="rounded-md border border-border bg-secondary/50 p-3 text-sm text-muted-foreground">
            Sua assinatura foi cancelada. Você mantém acesso até <strong>{formatDate(sub.currentPeriodEnd)}</strong>.
            Depois disso, sua chave será bloqueada.
          </div>
        )}

        {portal && (
          <div className="flex gap-3 pt-2">
            <Button asChild variant="default">
              <a href={portal} target="_blank" rel="noopener noreferrer">
                Gerenciar na Kirvano <ExternalLink className="w-4 h-4 ml-2" />
              </a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PaymentCard({ lastPayment }: { lastPayment: PaymentsResponse['payments'][number] | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Último pagamento</CardTitle>
      </CardHeader>
      <CardContent>
        {!lastPayment ? (
          <p className="text-sm text-muted-foreground">Nenhum pagamento registrado ainda.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3 text-sm">
            <Row label="Valor">
              <span className="font-medium">{formatBRL(lastPayment.paidAmountCents)}</span>
            </Row>
            <Row label="Data">
              <span>{formatDate(lastPayment.paidAt || lastPayment.createdAt)}</span>
            </Row>
            <Row label="Método">
              <span className="capitalize">
                {lastPayment.paymentMethod?.toLowerCase().replace('_', ' ') || '—'}
              </span>
            </Row>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}
