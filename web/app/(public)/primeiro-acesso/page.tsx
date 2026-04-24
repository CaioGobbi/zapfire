'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { consumeMagicLink, requestMagicLink } from '@/lib/auth';
import { useAuthStore } from '@/lib/authStore';

// ============================================================
// /primeiro-acesso
// ============================================================
// Dois modos, decididos pelo query param ?token=:
//   - com token: formulário "Configure sua senha" (consome + loga)
//   - sem token:  formulário "Pedir novo link" (só email)
// ============================================================

export default function PrimeiroAcessoPage() {
  const search = useSearchParams();
  const token = search.get('token') || '';

  return token
    ? <ConfigurarSenhaForm token={token} />
    : <PedirLinkForm />;
}

function ConfigurarSenhaForm({ token }: { token: string }) {
  const router = useRouter();
  const { hydrated, accessToken } = useAuthStore();
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [loading, setLoading] = useState(false);

  // Se já logado, chuta pro dashboard
  useEffect(() => {
    if (hydrated && accessToken) router.replace('/dashboard');
  }, [hydrated, accessToken, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pwd.length < 8) {
      toast.error('Senha precisa ter no mínimo 8 caracteres');
      return;
    }
    if (pwd !== pwd2) {
      toast.error('As senhas não conferem');
      return;
    }
    setLoading(true);
    try {
      await consumeMagicLink(token, pwd);
      toast.success('Senha configurada — bem-vindo!');
      router.replace('/dashboard');
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'INVALID_TOKEN'
            ? 'Link inválido ou expirado. Solicite um novo.'
            : err.message
          : 'Falha ao configurar — tente de novo';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm border-border/60 bg-card/60 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-xl">Configure sua senha</CardTitle>
        <CardDescription>
          Só precisa fazer isso uma vez. Depois é só logar com email+senha.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="pwd">Nova senha</Label>
            <Input
              id="pwd"
              type="password"
              autoComplete="new-password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pwd2">Confirmar senha</Label>
            <Input
              id="pwd2"
              type="password"
              autoComplete="new-password"
              value={pwd2}
              onChange={(e) => setPwd2(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Configurando…' : 'Configurar e entrar'}
          </Button>
        </form>
        <div className="mt-6 text-sm text-muted-foreground text-center">
          <Link href="/login" className="hover:underline">
            Já tenho senha, fazer login
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function PedirLinkForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    try {
      await requestMagicLink(email.trim().toLowerCase());
      setSent(true);
    } catch {
      // Backend sempre retorna 200 mesmo se email não existe (anti-enumeration)
      // — falha aqui só se for erro de rede
      toast.error('Falha ao enviar — tente de novo');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm border-border/60 bg-card/60 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-xl">Primeiro acesso</CardTitle>
        <CardDescription>
          Informe o email da sua compra. Enviaremos um link pra você configurar a senha.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="space-y-4">
            <div className="rounded-md border border-zf-success/30 bg-zf-success/10 p-4 text-sm">
              Se o email estiver cadastrado, você receberá um link em instantes.
              Confira sua caixa de entrada (e o spam).
            </div>
            <Link href="/login" className="block text-sm text-muted-foreground text-center hover:underline">
              Voltar pra tela de login
            </Link>
          </div>
        ) : (
          <>
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Enviando…' : 'Enviar link'}
              </Button>
            </form>
            <div className="mt-6 text-sm text-muted-foreground text-center">
              <Link href="/login" className="hover:underline">
                Já tenho senha, fazer login
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
