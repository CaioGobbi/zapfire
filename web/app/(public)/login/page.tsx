'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { loginWithPassword } from '@/lib/auth';
import { useAuthStore } from '@/lib/authStore';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const { hydrated, accessToken } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // Se já logado, manda pro dashboard
  useEffect(() => {
    if (hydrated && accessToken) router.replace('/dashboard');
  }, [hydrated, accessToken, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    try {
      await loginWithPassword(email.trim().toLowerCase(), password);
      router.replace('/dashboard');
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'PASSWORD_NOT_SET'
            ? 'Você ainda não configurou sua senha. Use o link enviado por email.'
            : err.code === 'RATE_LIMIT_EMAIL'
              ? 'Muitas tentativas. Aguarde 1 hora.'
              : err.message
          : 'Falha ao entrar — tente de novo';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm border-border/60 bg-card/60 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-xl">Entrar no painel</CardTitle>
        <CardDescription>Use o email e senha da sua conta Zapfire.</CardDescription>
      </CardHeader>
      <CardContent>
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
          <div className="space-y-2">
            <Label htmlFor="password">Senha</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Entrando…' : 'Entrar'}
          </Button>
        </form>
        <div className="mt-6 text-sm text-muted-foreground text-center">
          <Link href="/primeiro-acesso" className="text-zf-accent hover:underline">
            Primeiro acesso? Configurar minha senha
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
