'use client';

import { useEffect, useState } from 'react';
import { Smartphone, Laptop, Globe, RotateCcw, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { formatDateTime, maskPhone } from '@/lib/format';
import { cn } from '@/lib/utils';

interface KeysResponse {
  ok: boolean;
  keys: Array<{
    id: string;
    keyValue: string;
    label: string;
    boundPhone: string | null;
    boundAt: string | null;
    status: string;
    resetCount30d: number;
    resetCount30dResetAt: string | null;
    lastResetAt: string | null;
  }>;
}

interface DevicesResponse {
  ok: boolean;
  devices: Array<{
    id: string;
    deviceId: string;
    userAgent: string | null;
    ipAddress: string | null;
    chromeVersion: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
}

export default function DispositivosPage() {
  const [key, setKey] = useState<KeysResponse['keys'][number] | null>(null);
  const [devices, setDevices] = useState<DevicesResponse['devices']>([]);
  const [loading, setLoading] = useState(true);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function reload() {
    const keysRes = await apiGet<KeysResponse>('/account/keys');
    const k = keysRes.keys[0];
    setKey(k || null);
    if (k) {
      const devRes = await apiGet<DevicesResponse>(`/account/keys/${k.id}/devices`);
      setDevices(devRes.devices);
    } else {
      setDevices([]);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        await reload();
      } catch (err) {
        console.error('dispositivos load', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onConfirmReset() {
    if (!key) return;
    setResetting(true);
    try {
      await apiPost(`/account/keys/${key.id}/reset-bind`);
      toast.success('Vínculo resetado. Abra a extensão com o novo número pra refazer o bind.');
      setResetOpen(false);
      await reload();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'RESET_LIMIT'
            ? 'Você já usou o reset deste mês. Entre em contato com o suporte.'
            : err.message
          : 'Falha ao resetar — tente de novo';
      toast.error(msg);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dispositivos</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Número vinculado e Chromes ativos. Você pode resetar o vínculo 1× por mês.
        </p>
      </div>

      {loading ? (
        <>
          <Skeleton className="h-40" />
          <Skeleton className="h-56" />
        </>
      ) : !key ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Nenhuma chave cadastrada ainda.
          </CardContent>
        </Card>
      ) : (
        <>
          <BindCard k={key} onClickReset={() => setResetOpen(true)} />
          <DevicesCard devices={devices} />
        </>
      )}

      <ResetDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        k={key}
        resetting={resetting}
        onConfirm={onConfirmReset}
      />
    </div>
  );
}

// ============================================================
function BindCard({
  k,
  onClickReset,
}: {
  k: KeysResponse['keys'][number];
  onClickReset: () => void;
}) {
  const alreadyReset =
    k.resetCount30d > 0 &&
    k.resetCount30dResetAt &&
    Date.now() - new Date(k.resetCount30dResetAt).getTime() < 30 * 86400000;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-zf-type-audio" /> Número vinculado
        </CardTitle>
        {k.boundPhone && (
          <Button
            variant="outline"
            size="sm"
            onClick={onClickReset}
            disabled={!!alreadyReset}
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Resetar vínculo
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {k.boundPhone ? (
          <>
            <div className="text-2xl font-semibold font-mono">{maskPhone(k.boundPhone)}</div>
            <p className="text-xs text-muted-foreground">
              Vinculado em {formatDateTime(k.boundAt)}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            Nenhum número vinculado ainda. Cole a chave no popup da extensão pra fazer o primeiro bind.
          </p>
        )}

        {alreadyReset && (
          <div className="mt-3 rounded-md border border-border bg-secondary/50 p-3 text-xs text-muted-foreground flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-zf-warning flex-shrink-0 mt-0.5" />
            <div>
              Você já usou o reset gratuito deste mês
              {k.lastResetAt && ` em ${formatDateTime(k.lastResetAt)}`}.
              Próximo reset automático em breve, ou fale com o suporte.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
function DevicesCard({ devices }: { devices: DevicesResponse['devices'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Laptop className="w-4 h-4 text-zf-type-text" />
          Dispositivos ativos
          <Badge variant="secondary" className="ml-1">{devices.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className={cn(devices.length === 0 && 'pt-0')}>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum dispositivo ativo. Os dispositivos aparecem aqui depois do primeiro uso da chave.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Navegador</TableHead>
                <TableHead className="hidden sm:table-cell">IP</TableHead>
                <TableHead>Último uso</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className="truncate max-w-[320px]" title={d.userAgent || ''}>
                        {summarizeUserAgent(d.userAgent)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground font-mono text-xs">
                    {d.ipAddress || '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(d.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// Extrai o nome curto do browser do UA
function summarizeUserAgent(ua: string | null): string {
  if (!ua) return 'Desconhecido';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return ua.slice(0, 40) + '…';
}

// ============================================================
function ResetDialog({
  open,
  onOpenChange,
  k,
  resetting,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  k: KeysResponse['keys'][number] | null;
  resetting: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resetar vínculo do número?</DialogTitle>
          <DialogDescription className="pt-2 space-y-2">
            <div>
              Isso vai desvincular o número{' '}
              <strong className="text-foreground font-mono">{k ? maskPhone(k.boundPhone) : ''}</strong>{' '}
              da sua chave e remover todos os dispositivos ativos.
            </div>
            <div className="rounded-md border border-zf-warning/30 bg-zf-warning/10 p-3 text-sm text-zf-warning">
              <strong>Atenção:</strong> você só pode fazer isso <strong>1× por mês</strong>. Se precisar de
              um novo reset antes disso, vai ter que falar com o suporte.
            </div>
            <div className="text-muted-foreground text-sm">
              Após confirmar, abra a extensão no WhatsApp Web do número novo pra refazer o bind.
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={resetting}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} disabled={resetting}>
            {resetting ? 'Resetando…' : 'Resetar vínculo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
