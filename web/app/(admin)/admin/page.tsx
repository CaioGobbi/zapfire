'use client';

import { useEffect, useState } from 'react';
import { Users, Key, CreditCard, TrendingUp, AlertTriangle, Activity } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet } from '@/lib/api';
import { formatBRL } from '@/lib/format';

interface StatsResponse {
  ok: boolean;
  stats: {
    users: { total: number; active: number };
    keys: { total: number; active: number; blocked: number };
    subscriptions: { active: number; canceled: number; expired: number; inGrace: number };
    last7dSignups: number;
    last30d: { paymentCount: number; revenueCents: number };
    mrrCents: number;
  };
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<StatsResponse['stats'] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<StatsResponse>('/admin/stats');
        setData(res.stats);
      } catch (err) {
        console.error('admin stats', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Visão geral do negócio.</p>
      </div>

      {loading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              icon={Users}
              label="Usuários"
              value={data.users.total}
              hint={`${data.users.active} ativos`}
              color="text-zf-type-text"
            />
            <StatCard
              icon={Key}
              label="Chaves"
              value={data.keys.total}
              hint={`${data.keys.active} ativas · ${data.keys.blocked} bloq.`}
              color="text-zf-type-audio"
            />
            <StatCard
              icon={CreditCard}
              label="Assinaturas ativas"
              value={data.subscriptions.active}
              hint={`${data.subscriptions.canceled} canceladas · ${data.subscriptions.expired} expiradas`}
              color="text-zf-success"
            />
            <StatCard
              icon={AlertTriangle}
              label="Em grace"
              value={data.subscriptions.inGrace}
              hint="Vencem em ≤3 dias"
              color="text-zf-warning"
            />
            <StatCard
              icon={TrendingUp}
              label="MRR aproximado"
              value={formatBRL(data.mrrCents)}
              hint="Monthly + (Annual/12)"
              color="text-zf-accent"
            />
            <StatCard
              icon={Activity}
              label="Últimos 30d"
              value={formatBRL(data.last30d.revenueCents)}
              hint={`${data.last30d.paymentCount} pagamentos · ${data.last7dSignups} signups (7d)`}
              color="text-zf-type-media"
            />
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  color,
}: {
  icon: any;
  label: string;
  value: string | number;
  hint: string;
  color: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-2">
          <Icon className={`w-3.5 h-3.5 ${color}`} />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{hint}</div>
      </CardContent>
    </Card>
  );
}
