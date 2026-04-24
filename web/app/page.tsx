'use client';

// ============================================================
// Root / — redireciona pra /dashboard (se logado) ou /login
// ============================================================
// A decisão fica em useEffect depois do bootstrap pra evitar
// flicker de redirect errado antes do cookie ser trocado.
// ============================================================

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/authStore';

export default function Root() {
  const router = useRouter();
  const { hydrated, accessToken } = useAuthStore();

  useEffect(() => {
    if (!hydrated) return;
    router.replace(accessToken ? '/dashboard' : '/login');
  }, [hydrated, accessToken, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-zf-text-dim text-sm">Zapfire…</div>
    </div>
  );
}
