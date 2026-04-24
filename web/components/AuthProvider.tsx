'use client';

// ============================================================
// AUTH PROVIDER — executa bootstrapSession() no mount do app
// ============================================================
// Coloca isso no root layout. No 1º render do cliente ele tenta
// trocar o cookie de refresh por um novo access token. Enquanto
// `hydrated` for false, os layouts protegidos exibem um esqueleto
// em vez de redirecionar.
// ============================================================

import { useEffect } from 'react';
import { bootstrapSession } from '@/lib/auth';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    bootstrapSession();
  }, []);
  return <>{children}</>;
}
