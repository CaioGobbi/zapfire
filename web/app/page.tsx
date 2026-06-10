// ============================================================
// Landing page pública (rota /)
// ============================================================
// Renderiza o shell com URLs default da Kirvano (sem ?aff).
// Variantes de afiliado vivem em app/[affiliate]/page.tsx.
// ============================================================

import { LandingShell } from '@/components/landing-shell';

const KIRVANO_CHECKOUT_URL = 'https://pay.kirvano.com/10eb5393-19a0-4894-ab70-292b49b5c84c';
const KIRVANO_CHECKOUT_ANNUAL_URL = 'https://pay.kirvano.com/7b80209b-9bb7-43f1-95a0-346a6fe35fd5';

export default function LandingPage() {
  return (
    <LandingShell
      monthlyUrl={KIRVANO_CHECKOUT_URL}
      annualUrl={KIRVANO_CHECKOUT_ANNUAL_URL}
    />
  );
}
