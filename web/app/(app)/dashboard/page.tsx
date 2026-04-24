'use client';

import { useAuthStore } from '@/lib/authStore';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardPage() {
  const { user } = useAuthStore();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Olá{user?.fullName ? `, ${user.fullName}` : ''}. Bem-vindo de volta.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sessão ativa</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <div><span className="text-foreground">{user?.email}</span></div>
          <div>role: {user?.role}</div>
          <div>email verificado: {user?.emailVerified ? 'sim' : 'não'}</div>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Conteúdo real (chave, vencimento, banner de grace) chega na próxima sub-etapa.
        </CardContent>
      </Card>
    </div>
  );
}
