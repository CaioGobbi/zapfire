'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Copy, Check, AlertTriangle, CreditCard, Key, Smartphone, CalendarClock, Chrome, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet } from '@/lib/api';
import { useAuthStore } from '@/lib/authStore';
import { formatBRL, formatDate, formatKey, maskPhone, copyToClipboard } from '@/lib/format';
import { cn } from '@/lib/utils';

const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/zapfire-%E2%80%94-superpoderes-no/nnmdjgepomoiongkabkmjnpccbpkdnmb';

// ============================================================
// Types do que o backend devolve (espelha account.js)
// ============================================================
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

interface KeysResponse {
  ok: boolean;
  keys: Array<{
    id: string;
    keyValue: string;
    label: string;
    boundPhone: string | null;
    boundAt: string | null;
    status: 'ACTIVE' | 'SUSPENDED' | 'BLOCKED' | 'EXPIRED';
    blockedReason: string | null;
    lastUsedAt: string | null;
    resetCount30d: number;
    lastResetAt: string | null;
    createdAt: string;
  }>;
}

// ============================================================
export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const [sub, setSub] = useState<SubscriptionResponse['subscription'] | null>(null);
  const [keys, setKeys] = useState<KeysResponse['keys']>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [subRes, keysRes] = await Promise.all([
          apiGet<SubscriptionResponse>('/account/subscription'),
          apiGet<KeysResponse>('/account/keys'),
        ]);
        setSub(subRes.subscription);
        setKeys(keysRes.keys);
      } catch (err) {
        console.error('dashboard load', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onCopy(id: string, value: string) {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(id);
      toast.success('Copiado pra área de transferência');
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } else {
      toast.error('Falha ao copiar');
    }
  }

  // Chave principal = 1ª da lista (ordenada desc por createdAt no backend)
  const mainKey = keys[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {user?.fullName ? `Olá, ${user.fullName}` : 'Bem-vindo'}.
        </p>
      </div>

      {/* Banner grace / expirado */}
      {sub?.inGracePeriod && <GracePeriodBanner daysLeft={sub.daysLeftGrace} graceEndsAt={sub.gracePeriodEndsAt} />}
      {sub?.status === 'EXPIRED' && <ExpiredBanner />}
      {sub?.status === 'BLOCKED' && <BlockedBanner />}

      {loading ? <DashboardSkeleton /> : (
        <>
          {/* Cards principais */}
          <div className="grid gap-4 md:grid-cols-2">
            <KeyCard k={mainKey} onCopy={onCopy} copied={copied} />
            <SubscriptionCard sub={sub} />
          </div>

          {/* Resumo vinculação */}
          <BindCard k={mainKey} />
        </>
      )}
    </div>
  );
}

// ============================================================
// Sub-componentes
// ============================================================

function GracePeriodBanner({ daysLeft, graceEndsAt }: { daysLeft: number | null; graceEndsAt: string | null }) {
  return (
    <div className="rounded-lg border border-zf-accent/50 bg-zf-accent/10 p-4 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-zf-accent flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-semibold text-zf-accent">
          Assinatura vencida — {daysLeft ?? '?'} {daysLeft === 1 ? 'dia' : 'dias'} de tolerância
        </div>
        <div className="text-sm text-muted-foreground mt-1">
          Sua chave continua funcionando até {formatDate(graceEndsAt)}. Depois disso será bloqueada
          até a renovação. Renove agora pra evitar interrupção.
        </div>
      </div>
      <Button asChild variant="default" size="sm">
        <Link href="/assinatura">Renovar</Link>
      </Button>
    </div>
  );
}

function ExpiredBanner() {
  return (
    <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-semibold text-red-500">Assinatura expirada</div>
        <div className="text-sm text-muted-foreground mt-1">
          Sua chave foi bloqueada. Renove pra voltar a usar a extensão.
        </div>
      </div>
      <Button asChild variant="default" size="sm">
        <Link href="/assinatura">Renovar</Link>
      </Button>
    </div>
  );
}

function BlockedBanner() {
  return (
    <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-semibold text-red-500">Assinatura bloqueada</div>
        <div className="text-sm text-muted-foreground mt-1">
          Entre em contato com o suporte.
        </div>
      </div>
    </div>
  );
}

function KeyCard({
  k,
  onCopy,
  copied,
}: {
  k: KeysResponse['keys'][number] | undefined;
  onCopy: (id: string, value: string) => void;
  copied: string | null;
}) {
  if (!k) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="w-4 h-4 text-zf-accent" /> Chave de acesso
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Nenhuma chave ainda.
        </CardContent>
      </Card>
    );
  }
  const statusLabel: Record<string, string> = {
    ACTIVE: 'Ativa',
    SUSPENDED: 'Suspensa',
    BLOCKED: 'Bloqueada',
    EXPIRED: 'Expirada',
  };
  const isCopied = copied === k.id;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Key className="w-4 h-4 text-zf-accent" /> Chave de acesso
        </CardTitle>
        <Badge variant={k.status === 'ACTIVE' ? 'default' : 'destructive'}>
          {statusLabel[k.status] || k.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-secondary px-3 py-2 rounded-md font-mono text-sm text-zf-accent break-all select-all">
            {formatKey(k.keyValue)}
          </code>
          <Button size="icon" variant="ghost" onClick={() => onCopy(k.id, k.keyValue)} aria-label="Copiar">
            {isCopied ? <Check className="w-4 h-4 text-zf-success" /> : <Copy className="w-4 h-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Instale a extensão e cole a chave no popup pra ativar.
        </p>
        <Button asChild variant="outline" className="w-full">
          <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noopener noreferrer">
            <Chrome className="w-4 h-4 mr-2" />
            Instalar extensão no Chrome
            <ExternalLink className="w-3 h-3 ml-2 opacity-60" />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

function SubscriptionCard({ sub }: { sub: SubscriptionResponse['subscription'] }) {
  if (!sub) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-zf-type-text" /> Assinatura
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Nenhuma assinatura ativa.
        </CardContent>
      </Card>
    );
  }
  const statusLabel: Record<string, { text: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }> = {
    ACTIVE:   { text: 'Ativa',     variant: 'default' },
    CANCELED: { text: 'Cancelada', variant: 'secondary' },
    PAST_DUE: { text: 'Atrasada',  variant: 'destructive' },
    EXPIRED:  { text: 'Expirada',  variant: 'destructive' },
    BLOCKED:  { text: 'Bloqueada', variant: 'destructive' },
  };
  const st = statusLabel[sub.status] || { text: sub.status, variant: 'outline' as const };
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-zf-type-text" /> Assinatura
        </CardTitle>
        <Badge variant={st.variant}>{st.text}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row label="Plano">
          <span className="font-medium">{sub.planName}</span>
          <span className="text-muted-foreground"> · {formatBRL(sub.priceCents)}</span>
        </Row>
        <Row label={sub.status === 'CANCELED' ? 'Ativa até' : 'Próxima cobrança'}>
          <span className="font-medium">{formatDate(sub.currentPeriodEnd)}</span>
        </Row>
        <Row label="Renovação">
          <span className="text-muted-foreground">
            {sub.autoRenew ? 'Automática' : 'Manual'}
          </span>
        </Row>
      </CardContent>
    </Card>
  );
}

function BindCard({ k }: { k: KeysResponse['keys'][number] | undefined }) {
  if (!k) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-zf-type-audio" /> Vinculação
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3 text-sm">
        <Row label="Número vinculado">
          {k.boundPhone ? (
            <span className="font-medium">{maskPhone(k.boundPhone)}</span>
          ) : (
            <span className="text-muted-foreground italic">aguardando primeiro uso</span>
          )}
        </Row>
        <Row label="Vinculada em">
          <span className={cn(k.boundAt ? '' : 'text-muted-foreground italic')}>
            {k.boundAt ? formatDate(k.boundAt) : '—'}
          </span>
        </Row>
        <Row label="Último uso">
          <span className={cn(k.lastUsedAt ? '' : 'text-muted-foreground italic')}>
            {k.lastUsedAt ? formatDate(k.lastUsedAt) : '—'}
          </span>
        </Row>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="h-28" />
    </div>
  );
}
