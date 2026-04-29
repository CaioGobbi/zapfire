'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  RotateCcw,
  Unlock,
  Shield,
  ShieldOff,
  CalendarPlus,
  UserCog,
  Check,
  Copy,
  KeyRound,
  Lock,
  Mail,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { formatBRL, formatDate, formatDateTime, formatKey, maskPhone, copyToClipboard } from '@/lib/format';

// ============================================================
// Types (espelha o retorno do /api/v1/admin/users/:id)
// ============================================================
interface UserDetail {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  cpfCnpj: string | null;
  role: 'CUSTOMER' | 'AFFILIATE' | 'ADMIN';
  isActive: boolean;
  emailVerified: boolean;
  passwordSetAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

interface KeyDetail {
  id: string;
  keyValue: string;
  label: string;
  boundPhone: string | null;
  boundAt: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'BLOCKED' | 'EXPIRED';
  blockedReason: string | null;
  blockedAt: string | null;
  lastUsedAt: string | null;
  resetCount30d: number;
  resetCount30dResetAt: string | null;
  lastResetAt: string | null;
  createdAt: string;
  devices: Array<{
    id: string;
    userAgent: string | null;
    ipAddress: string | null;
    lastSeenAt: string;
  }>;
  _count: { devices: number; validations: number };
}

interface SubscriptionDetail {
  id: string;
  status: string;
  gatewayProvider: string;
  currentPeriodEnd: string;
  canceledAt: string | null;
  cancelReason: string | null;
  autoRenew: boolean;
  gracePeriodEndsAt: string | null;
  kirvanoStatus: string | null;
  createdAt: string;
  plan: { code: string; name: string; priceCents: number; billingCycle: string };
}

interface DetailResponse {
  ok: boolean;
  user: UserDetail;
  keys: KeyDetail[];
  subscriptions: SubscriptionDetail[];
  recentPayments: Array<{
    id: string;
    paidAmountCents: number;
    status: string;
    paymentMethod: string | null;
    paidAt: string | null;
    createdAt: string;
  }>;
  recentValidations: Array<{
    id: string;
    result: string;
    reason: string | null;
    ipAddress: string;
    createdAt: string;
  }>;
  recentAudit: Array<{
    id: string;
    action: string;
    entityType: string | null;
    entityId: string | null;
    metadata: any;
    ipAddress: string | null;
    createdAt: string;
  }>;
}

const KEY_STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  SUSPENDED: 'secondary',
  BLOCKED: 'destructive',
  EXPIRED: 'destructive',
};

const SUB_STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  CANCELED: 'secondary',
  PAST_DUE: 'destructive',
  EXPIRED: 'destructive',
  BLOCKED: 'destructive',
  PENDING: 'outline',
};

// ============================================================
export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<DetailResponse>(`/admin/users/${id}`);
      setData(res);
    } catch (err) {
      console.error('user detail', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (!data?.user) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">Usuário não encontrado.</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BackLink />
      <UserHeader user={data.user} onAction={load} />

      <Tabs defaultValue="keys">
        <TabsList>
          <TabsTrigger value="keys">Chaves ({data.keys.length})</TabsTrigger>
          <TabsTrigger value="subs">Assinaturas ({data.subscriptions.length})</TabsTrigger>
          <TabsTrigger value="payments">Pagamentos ({data.recentPayments.length})</TabsTrigger>
          <TabsTrigger value="validations">Validações ({data.recentValidations.length})</TabsTrigger>
          <TabsTrigger value="audit">Audit ({data.recentAudit.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="keys" className="mt-4 space-y-4">
          {data.keys.length === 0 ? (
            <EmptyNote>Nenhuma chave.</EmptyNote>
          ) : (
            data.keys.map((k) => <KeyCard key={k.id} k={k} onAction={load} />)
          )}
        </TabsContent>

        <TabsContent value="subs" className="mt-4 space-y-4">
          {data.subscriptions.length === 0 ? (
            <EmptyNote>Nenhuma assinatura.</EmptyNote>
          ) : (
            data.subscriptions.map((s) => <SubCard key={s.id} s={s} onAction={load} />)
          )}
        </TabsContent>

        <TabsContent value="payments" className="mt-4">
          {data.recentPayments.length === 0 ? (
            <EmptyNote>Sem pagamentos.</EmptyNote>
          ) : (
            <Card><CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Valor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">Método</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentPayments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-muted-foreground">{formatDateTime(p.paidAt || p.createdAt)}</TableCell>
                      <TableCell className="font-medium">{formatBRL(p.paidAmountCents)}</TableCell>
                      <TableCell><Badge variant={p.status === 'PAID' ? 'default' : 'destructive'}>{p.status}</Badge></TableCell>
                      <TableCell className="hidden sm:table-cell text-muted-foreground text-xs">{p.paymentMethod || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="validations" className="mt-4">
          {data.recentValidations.length === 0 ? (
            <EmptyNote>Sem validações.</EmptyNote>
          ) : (
            <Card><CardContent className="pt-6">
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
                  {data.recentValidations.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="text-muted-foreground">{formatDateTime(v.createdAt)}</TableCell>
                      <TableCell><Badge variant={v.result === 'SUCCESS' ? 'default' : 'destructive'}>{v.result}</Badge></TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground font-mono text-xs">{v.ipAddress}</TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground text-xs">{v.reason || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          {data.recentAudit.length === 0 ? (
            <EmptyNote>Sem registros de audit.</EmptyNote>
          ) : (
            <Card><CardContent className="pt-6 space-y-2">
              {data.recentAudit.map((a) => (
                <div key={a.id} className="text-xs flex gap-3 py-1 border-b border-border/50 last:border-0">
                  <span className="text-muted-foreground shrink-0 w-32">{formatDateTime(a.createdAt)}</span>
                  <span className="font-mono text-zf-accent shrink-0">{a.action}</span>
                  {a.metadata && Object.keys(a.metadata).length > 0 && (
                    <code className="text-muted-foreground truncate font-mono text-[10px]">
                      {JSON.stringify(a.metadata)}
                    </code>
                  )}
                </div>
              ))}
            </CardContent></Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
function BackLink() {
  return (
    <Link href="/admin/usuarios" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
      <ArrowLeft className="w-4 h-4" /> Voltar pra lista
    </Link>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <Card><CardContent className="pt-6 text-sm text-muted-foreground text-center">{children}</CardContent></Card>
  );
}

// ============================================================
function UserHeader({ user, onAction }: { user: UserDetail; onAction: () => void }) {
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [setPwOpen, setSetPwOpen] = useState(false);
  const [grantKeyOpen, setGrantKeyOpen] = useState(false);
  const [magicLinkBusy, setMagicLinkBusy] = useState(false);
  const [magicLinkResult, setMagicLinkResult] = useState<{
    url: string; emailSent: boolean; emailMockMode: boolean;
  } | null>(null);

  async function sendMagicLink() {
    if (!confirm(`Enviar magic link novo pra ${user.email}?\nO cliente recebe email com link válido por 7 dias.`)) return;
    setMagicLinkBusy(true);
    try {
      const res = await apiPost<{ ok: boolean; magicLinkUrl: string; emailSent: boolean; emailMockMode: boolean }>(
        `/admin/users/${user.id}/send-magic-link`,
      );
      // Sempre abre dialog com a URL — admin tem cópia mesmo se email falhou
      // ou caiu em spam, e pode entregar manual via WhatsApp se quiser.
      setMagicLinkResult({
        url: res.magicLinkUrl,
        emailSent: res.emailSent,
        emailMockMode: res.emailMockMode,
      });
      onAction();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Falha — veja console';
      toast.error(msg);
    } finally {
      setMagicLinkBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-semibold truncate">{user.email}</h2>
            <Badge variant={user.role === 'ADMIN' ? 'default' : 'outline'}>{user.role}</Badge>
            {!user.isActive && <Badge variant="destructive">Inativo</Badge>}
            {!user.emailVerified && <Badge variant="outline">Email não verif.</Badge>}
            {!user.passwordSetAt && <Badge variant="outline">Sem senha</Badge>}
          </div>
          <div className="text-sm text-muted-foreground">{user.fullName || '(sem nome)'}</div>
          <div className="text-xs text-muted-foreground mt-2 space-x-4">
            <span>Criado: <span className="text-foreground">{formatDateTime(user.createdAt)}</span></span>
            <span>Último login: <span className="text-foreground">{formatDateTime(user.lastLoginAt)}</span></span>
          </div>
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => setGrantKeyOpen(true)}>
            <KeyRound className="w-4 h-4 mr-2" /> Nova chave
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSetPwOpen(true)}>
            <Lock className="w-4 h-4 mr-2" /> Credenciais
          </Button>
          <Button variant="outline" size="sm" onClick={sendMagicLink} disabled={magicLinkBusy}>
            <Mail className="w-4 h-4 mr-2" /> {magicLinkBusy ? 'Enviando…' : 'Enviar magic link'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPromoteOpen(true)}>
            <UserCog className="w-4 h-4 mr-2" /> Mudar role
          </Button>
        </div>
      </CardHeader>
      <PromoteDialog
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        user={user}
        onDone={() => { setPromoteOpen(false); onAction(); }}
      />
      <CredentialsDialog
        open={setPwOpen}
        onOpenChange={setSetPwOpen}
        userId={user.id}
        userEmail={user.email}
        onDone={() => { setSetPwOpen(false); onAction(); }}
      />
      <GrantKeyDialog
        open={grantKeyOpen}
        onOpenChange={setGrantKeyOpen}
        userId={user.id}
        userEmail={user.email}
        onDone={() => { setGrantKeyOpen(false); onAction(); }}
      />
      <MagicLinkResultDialog
        result={magicLinkResult}
        userEmail={user.email}
        onClose={() => setMagicLinkResult(null)}
      />
    </Card>
  );
}

function MagicLinkResultDialog({
  result, userEmail, onClose,
}: {
  result: { url: string; emailSent: boolean; emailMockMode: boolean } | null;
  userEmail: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!result) return null;

  async function copyUrl() {
    if (await copyToClipboard(result!.url)) {
      setCopied(true);
      toast.success('Link copiado');
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Falha ao copiar');
    }
  }

  // Mensagem de status do email
  let statusLine: React.ReactNode;
  if (result.emailSent && !result.emailMockMode) {
    statusLine = (
      <span className="text-green-500">
        ✓ Email enviado — pede pro cliente checar a caixa principal e a aba de promoções/spam
      </span>
    );
  } else if (result.emailMockMode) {
    statusLine = (
      <span className="text-amber-500">
        ⚠ Modo MOCK no backend (RESEND_API_KEY vazia) — entregue o link manualmente
      </span>
    );
  } else {
    statusLine = (
      <span className="text-amber-500">
        ⚠ Envio falhou — confira logs do Railway por <code>[resend:error]</code>; entregue o link manualmente
      </span>
    );
  }

  return (
    <Dialog open={!!result} onOpenChange={(v) => { if (!v) { onClose(); setCopied(false); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Magic link gerado</DialogTitle>
          <DialogDescription>
            Pra <strong>{userEmail}</strong> — válido por 7 dias, uso único.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">URL do magic link</Label>
            <div className="mt-1 flex gap-2">
              <code className="flex-1 px-3 py-2 bg-muted rounded text-xs break-all font-mono">
                {result.url}
              </code>
              <Button variant="outline" size="sm" onClick={copyUrl} className="shrink-0">
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="text-xs">{statusLine}</div>
        </div>

        <DialogFooter>
          <Button onClick={() => { onClose(); setCopied(false); }}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
function KeyCard({ k, onAction }: { k: KeyDetail; onAction: () => void }) {
  const [copied, setCopied] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      toast.success('Ação executada');
      onAction();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Falha — veja console';
      toast.error(msg);
    } finally { setBusy(null); }
  }

  async function onCopy() {
    if (await copyToClipboard(k.keyValue)) {
      setCopied(true);
      toast.success('Chave copiada');
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant={KEY_STATUS_VARIANT[k.status] || 'outline'}>{k.status}</Badge>
            <span className="text-sm text-muted-foreground">{k.label}</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs font-mono text-zf-accent bg-secondary px-2 py-1 rounded truncate max-w-[360px]">
              {formatKey(k.keyValue)}
            </code>
            <Button size="icon" variant="ghost" onClick={onCopy} className="h-7 w-7">
              {copied ? <Check className="w-3.5 h-3.5 text-zf-success" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm sm:grid-cols-2 md:grid-cols-3">
          <InfoRow label="Vinculada a">
            {k.boundPhone ? maskPhone(k.boundPhone) : <span className="italic text-muted-foreground">—</span>}
          </InfoRow>
          <InfoRow label="Bind em">{k.boundAt ? formatDate(k.boundAt) : '—'}</InfoRow>
          <InfoRow label="Último uso">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : '—'}</InfoRow>
          <InfoRow label="Reset 30d">
            {k.resetCount30d}x
            {k.resetCount30dResetAt && ` (reset em ${formatDate(k.resetCount30dResetAt)})`}
          </InfoRow>
          <InfoRow label="Último reset">{k.lastResetAt ? formatDateTime(k.lastResetAt) : '—'}</InfoRow>
          <InfoRow label="Devices">{k._count.devices} · Validações: {k._count.validations}</InfoRow>
        </div>

        {k.blockedReason && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
            <strong className="text-destructive">Bloqueada:</strong> {k.blockedReason}
            {k.blockedAt && <span className="text-muted-foreground"> · {formatDateTime(k.blockedAt)}</span>}
          </div>
        )}

        {k.devices.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {k.devices.length} dispositivo(s)
            </summary>
            <div className="mt-2 space-y-1 pl-4">
              {k.devices.map((d) => (
                <div key={d.id} className="text-muted-foreground">
                  {summarizeUa(d.userAgent)} · {d.ipAddress || '?'} · {formatDateTime(d.lastSeenAt)}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
          <Button
            size="sm" variant="outline"
            disabled={!!busy}
            onClick={() => run('reset-bind', () => apiPost(`/admin/keys/${k.id}/reset-bind`))}
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Reset bind
          </Button>
          <Button
            size="sm" variant="outline"
            disabled={!!busy || k.resetCount30d === 0}
            onClick={() => run('unlock-reset', () => apiPost(`/admin/keys/${k.id}/unlock-reset`))}
          >
            <Unlock className="w-3.5 h-3.5 mr-1.5" />
            Liberar reset do mês
          </Button>
          {k.status === 'BLOCKED' ? (
            <Button
              size="sm" variant="outline"
              disabled={!!busy}
              onClick={() => run('unblock', () => apiPost(`/admin/keys/${k.id}/unblock`))}
            >
              <ShieldOff className="w-3.5 h-3.5 mr-1.5" />
              Desbloquear
            </Button>
          ) : (
            <Button
              size="sm" variant="outline"
              disabled={!!busy}
              onClick={() => setBlockOpen(true)}
            >
              <Shield className="w-3.5 h-3.5 mr-1.5" />
              Bloquear
            </Button>
          )}
        </div>
      </CardContent>

      <BlockKeyDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        keyId={k.id}
        onDone={() => { setBlockOpen(false); onAction(); }}
      />
    </Card>
  );
}

// ============================================================
function SubCard({ s, onAction }: { s: SubscriptionDetail; onAction: () => void }) {
  const [extendOpen, setExtendOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={SUB_STATUS_VARIANT[s.status] || 'outline'}>{s.status}</Badge>
            <span className="font-medium">{s.plan.name}</span>
            <span className="text-sm text-muted-foreground">{formatBRL(s.plan.priceCents)}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            Gateway: <span className="text-foreground">{s.gatewayProvider}</span>
            {s.kirvanoStatus && <> · Kirvano: <span className="text-foreground">{s.kirvanoStatus}</span></>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <InfoRow label="Vence em">{formatDate(s.currentPeriodEnd)}</InfoRow>
          <InfoRow label="Cancelada em">{s.canceledAt ? formatDate(s.canceledAt) : '—'}</InfoRow>
          <InfoRow label="Renovação">{s.autoRenew ? 'Auto' : 'Manual'}</InfoRow>
        </div>
        {s.cancelReason && (
          <div className="text-xs text-muted-foreground">
            Motivo: <span className="text-foreground">{s.cancelReason}</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
          <Button size="sm" variant="outline" onClick={() => setExtendOpen(true)}>
            <CalendarPlus className="w-3.5 h-3.5 mr-1.5" />
            Estender
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPlanOpen(true)}>
            Mudar plano
          </Button>
          <Button size="sm" variant="outline" onClick={() => setStatusOpen(true)}>
            Mudar status
          </Button>
        </div>
      </CardContent>

      <ExtendDialog
        open={extendOpen} onOpenChange={setExtendOpen}
        subId={s.id} currentEnd={s.currentPeriodEnd}
        onDone={() => { setExtendOpen(false); onAction(); }}
      />
      <ChangePlanDialog
        open={planOpen} onOpenChange={setPlanOpen}
        subId={s.id} currentPlanCode={s.plan.code} currentPlanName={s.plan.name}
        onDone={() => { setPlanOpen(false); onAction(); }}
      />
      <SetStatusDialog
        open={statusOpen} onOpenChange={setStatusOpen}
        subId={s.id} currentStatus={s.status}
        onDone={() => { setStatusOpen(false); onAction(); }}
      />
    </Card>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-foreground text-sm">{children}</span>
    </div>
  );
}

function summarizeUa(ua: string | null): string {
  if (!ua) return 'Desconhecido';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return ua.slice(0, 30);
}

// ============================================================
// Dialogs de ação
// ============================================================
function BlockKeyDialog({ open, onOpenChange, keyId, onDone }: any) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await apiPost(`/admin/keys/${keyId}/block`, { reason: reason.trim() || undefined });
      toast.success('Chave bloqueada');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bloquear chave</DialogTitle>
          <DialogDescription>
            A chave fica imediatamente inválida. O user vê "Envios bloqueados" na extensão.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">Motivo (opcional)</Label>
          <Input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex: compartilhamento indevido"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={go} disabled={busy}>{busy ? 'Bloqueando…' : 'Bloquear'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExtendDialog({ open, onOpenChange, subId, currentEnd, onDone }: any) {
  const [days, setDays] = useState<string>('30');
  const [busy, setBusy] = useState(false);
  async function go() {
    const n = parseInt(days, 10);
    if (!Number.isFinite(n) || n < 1) { toast.error('Quantidade inválida'); return; }
    setBusy(true);
    try {
      await apiPost(`/admin/subscriptions/${subId}/extend`, { days: n });
      toast.success(`Estendida em ${n} dias`);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Estender assinatura</DialogTitle>
          <DialogDescription>
            Vencimento atual: <strong>{formatDate(currentEnd)}</strong>. Se estiver EXPIRED, reativa pra ACTIVE.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="days">Dias</Label>
          <Input id="days" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={go} disabled={busy}>{busy ? 'Estendendo…' : 'Estender'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Hardcoded por simplicidade — quando virar > 5 planos ou variar muito,
// criar GET /admin/plans no backend e popular via fetch.
const PLAN_OPTIONS = [
  { code: 'monthly_v1', name: 'Mensal (R$47) — Free' },
  { code: 'annual_v1',  name: 'Anual (R$395) — Free' },
  { code: 'pro_v1',     name: 'Pro (R$97) — tracking + relatórios' },
  { code: 'monthly_x1', name: 'Mensal X1 (R$97) — legado' },
];

function ChangePlanDialog({ open, onOpenChange, subId, currentPlanCode, currentPlanName, onDone }: any) {
  const [planCode, setPlanCode] = useState(currentPlanCode);
  const [busy, setBusy] = useState(false);

  async function go() {
    if (planCode === currentPlanCode) {
      toast.warning('Selecione um plano diferente');
      return;
    }
    setBusy(true);
    try {
      const res = await apiPost<{ ok: boolean; message?: string; newPlanName?: string }>(
        `/admin/subscriptions/${subId}/change-plan`,
        { planCode },
      );
      toast.success(res.message || `Plano alterado pra ${res.newPlanName || planCode}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mudar plano da assinatura</DialogTitle>
          <DialogDescription>
            Plano atual: <strong>{currentPlanName}</strong>. Mudar plano só altera
            o vínculo + features (ex: liberar tracking pro Pro). Não toca em
            <code className="mx-1 px-1.5 py-0.5 rounded bg-muted text-xs">currentPeriodEnd</code>
            — pra estender prazo, use "Estender" separadamente. O usuário precisa
            relogar/refresh no WA Web pra UI refletir as features novas.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="plan-code">Novo plano</Label>
          <select
            id="plan-code"
            value={planCode}
            onChange={(e) => setPlanCode(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {PLAN_OPTIONS.map((p) => (
              <option key={p.code} value={p.code}>{p.name}</option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={go} disabled={busy}>{busy ? 'Alterando…' : 'Mudar plano'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SetStatusDialog({ open, onOpenChange, subId, currentStatus, onDone }: any) {
  const [status, setStatus] = useState(currentStatus);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await apiPost(`/admin/subscriptions/${subId}/set-status`, {
        status,
        reason: reason.trim() || undefined,
      });
      toast.success('Status atualizado');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setBusy(false); }
  }
  const options = ['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'BLOCKED'];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mudar status</DialogTitle>
          <DialogDescription>
            Status atual: <strong>{currentStatus}</strong>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="status">Novo status</Label>
            <select
              id="status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          {status === 'CANCELED' && (
            <div className="space-y-2">
              <Label htmlFor="reason">Motivo (opcional)</Label>
              <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={go} disabled={busy}>{busy ? 'Atualizando…' : 'Atualizar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialsDialog({ open, onOpenChange, userId, userEmail, onDone }: any) {
  const [novoEmail, setNovoEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [senha, setSenha] = useState('');
  const [confirma, setConfirma] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  function reset() {
    setNovoEmail(''); setEmailBusy(false);
    setSenha(''); setConfirma(''); setPwBusy(false);
  }

  async function changeEmail() {
    const trimmed = novoEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast.error('Email inválido'); return;
    }
    if (trimmed === userEmail.toLowerCase()) {
      toast.error('Esse já é o email atual'); return;
    }
    setEmailBusy(true);
    try {
      await apiPost(`/admin/users/${userId}/set-email`, { email: trimmed });
      toast.success('Email alterado — sessões anteriores invalidadas');
      setNovoEmail('');
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'EMAIL_IN_USE') toast.error('Esse email já é usado por outro usuário');
      else toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setEmailBusy(false); }
  }

  async function changePassword() {
    if (senha.length < 8) { toast.error('Mínimo 8 caracteres'); return; }
    if (senha !== confirma) { toast.error('Senhas não batem'); return; }
    setPwBusy(true);
    try {
      await apiPost(`/admin/users/${userId}/set-password`, { senha });
      toast.success('Senha definida — sessões anteriores invalidadas');
      setSenha(''); setConfirma('');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setPwBusy(false); }
  }

  const busy = emailBusy || pwBusy;

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar credenciais</DialogTitle>
          <DialogDescription>
            Operações independentes em <strong>{userEmail}</strong>.
            Cada ação invalida todas as sessões ativas (cliente precisa logar de novo).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Email */}
          <div className="space-y-2 pb-5 border-b border-border">
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Trocar email
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-email">Novo email</Label>
              <Input
                id="set-email" type="email" autoComplete="off"
                placeholder={userEmail}
                value={novoEmail} onChange={(e) => setNovoEmail(e.target.value)}
              />
            </div>
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={changeEmail} disabled={busy || !novoEmail.trim()}>
                {emailBusy ? 'Atualizando…' : 'Atualizar email'}
              </Button>
            </div>
          </div>

          {/* Senha */}
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Definir senha
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-pw">Nova senha (mín. 8 chars)</Label>
              <PasswordInput
                id="set-pw" autoComplete="new-password"
                value={senha} onChange={(e) => setSenha(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-pw-confirm">Confirmar</Label>
              <PasswordInput
                id="set-pw-confirm" autoComplete="new-password"
                value={confirma} onChange={(e) => setConfirma(e.target.value)}
              />
            </div>
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={changePassword} disabled={busy || !senha || !confirma}>
                {pwBusy ? 'Definindo…' : 'Definir senha'}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantKeyDialog({ open, onOpenChange, userId, userEmail, onDone }: any) {
  const [dias, setDias] = useState('365');
  const [planCode, setPlanCode] = useState<'monthly_v1' | 'annual_v1'>('monthly_v1');
  const [label, setLabel] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [keyValue, setKeyValue] = useState<string | null>(null);

  function reset() { setDias('365'); setPlanCode('monthly_v1'); setLabel(''); setSendEmail(true); setKeyValue(null); setBusy(false); }

  async function go() {
    const diasNum = parseInt(dias, 10);
    if (!Number.isFinite(diasNum) || diasNum <= 0) { toast.error('Dias inválido'); return; }
    setBusy(true);
    try {
      const res = await apiPost<{ ok: boolean; keyValue: string; emailSent: boolean; emailMockMode: boolean }>(
        `/admin/users/${userId}/grant-key`,
        { dias: diasNum, planCode, label: label.trim() || undefined, sendEmail },
      );
      setKeyValue(res.keyValue);
      toast.success('Nova chave criada' + (res.emailSent && !res.emailMockMode ? ' — email enviado' : ''));
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setBusy(false); }
  }

  if (keyValue) {
    return (
      <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova chave criada</DialogTitle>
            <DialogDescription>Pra {userEmail}</DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs text-muted-foreground">Chave de acesso</Label>
            <code className="block mt-1 px-3 py-2 bg-muted rounded text-xs break-all font-mono">{keyValue}</code>
          </div>
          <DialogFooter>
            <Button onClick={() => { reset(); onOpenChange(false); }}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Criar nova chave + assinatura</DialogTitle>
          <DialogDescription>
            Cria uma assinatura ACTIVE adicional pra <strong>{userEmail}</strong> + chave nova
            (não reusa a existente). Útil quando o cliente quer chave separada pra outro número.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gk-dias">Dias</Label>
              <Input id="gk-dias" type="number" min={1} max={3650} value={dias} onChange={(e) => setDias(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gk-plano">Plano</Label>
              <select
                id="gk-plano" value={planCode}
                onChange={(e) => setPlanCode(e.target.value as 'monthly_v1' | 'annual_v1')}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="monthly_v1">Mensal (R$47)</option>
                <option value="annual_v1">Anual (R$395)</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gk-label">Label da chave (opcional)</Label>
            <Input
              id="gk-label" type="text" value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex: Whatsapp secundário"
            />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            <span>Enviar email avisando da nova chave</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={go} disabled={busy}>{busy ? 'Criando…' : 'Criar chave'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromoteDialog({ open, onOpenChange, user, onDone }: any) {
  const [role, setRole] = useState(user.role);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await apiPost(`/admin/users/${user.id}/promote`, { role });
      toast.success(`Role alterada pra ${role}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Falha');
    } finally { setBusy(false); }
  }
  const options = ['CUSTOMER', 'AFFILIATE', 'ADMIN'];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mudar role</DialogTitle>
          <DialogDescription>
            Role atual: <strong>{user.role}</strong>. Cuidado ao rebaixar outros admins.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="role">Novo role</Label>
          <select
            id="role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={go} disabled={busy}>{busy ? 'Atualizando…' : 'Atualizar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
