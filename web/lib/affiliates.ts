// ============================================================
// Afiliados — landing variantes com URLs próprias de checkout
// ============================================================
// Pra adicionar um afiliado novo:
//   1. Pega os 2 URLs de checkout dele na Kirvano (mensal + anual)
//      — eles têm ?aff=<uuid-do-afiliado> appended pelo painel da Kirvano
//   2. Adiciona uma entrada nova no mapa abaixo com slug em kebab-case
//   3. Commit + deploy
//
// O webhook da Kirvano já recebe o offer_id correto, então a comissão
// é creditada automático no painel deles. Não precisa de nada extra
// do nosso lado pra tracking.
//
// Slugs reservados: NÃO use estes nomes (são rotas estáticas que
// vencem sobre o [affiliate] dinâmico no Next.js):
//   login, primeiro-acesso, privacy, dashboard, assinatura,
//   dispositivos, historico, admin
// Se alguém tentar usar um desses slugs como afiliado, a URL nunca
// chega aqui — vai pra rota estática correspondente.
// ============================================================

export type Affiliate = {
  slug: string;
  monthlyUrl: string;
  annualUrl: string;
};

const AFFILIATES: Record<string, Affiliate> = {
  gizinn: {
    slug: 'gizinn',
    monthlyUrl:
      'https://pay.kirvano.com/10eb5393-19a0-4894-ab70-292b49b5c84c?aff=58cc1d39-10d4-4aec-add2-69529d56b24a',
    annualUrl:
      'https://pay.kirvano.com/7b80209b-9bb7-43f1-95a0-346a6fe35fd5?aff=58cc1d39-10d4-4aec-add2-69529d56b24a',
  },
};

export function getAffiliate(slug: string): Affiliate | null {
  return AFFILIATES[slug.toLowerCase()] ?? null;
}

export function listAffiliateSlugs(): string[] {
  return Object.keys(AFFILIATES);
}
