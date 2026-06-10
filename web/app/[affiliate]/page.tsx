// ============================================================
// Landing por afiliado — rota /[slug]
// ============================================================
// Server component. Faz lookup do slug em lib/affiliates.ts e
// renderiza a mesma landing principal com URLs de checkout do
// afiliado (que já carregam ?aff=<uuid> da Kirvano).
//
// Slug inválido → 404 (renderiza app/not-found.tsx).
//
// Rotas estáticas vencem sobre essa rota dinâmica no Next App
// Router, então paths tipo /login, /dashboard, /privacy, etc.
// nunca caem aqui — vão pro page.tsx específico deles.
// ============================================================

import { notFound } from 'next/navigation';

import { LandingShell } from '@/components/landing-shell';
import { getAffiliate } from '@/lib/affiliates';

export default function AffiliateLandingPage({
  params,
}: {
  params: { affiliate: string };
}) {
  const affiliate = getAffiliate(params.affiliate);
  if (!affiliate) notFound();

  return (
    <LandingShell
      monthlyUrl={affiliate.monthlyUrl}
      annualUrl={affiliate.annualUrl}
    />
  );
}
