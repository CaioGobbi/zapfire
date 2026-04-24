// ============================================================
// KIRVANO PARSER — helpers puros pra consumir payload da Kirvano
// ============================================================
// Funções aqui são 100% funcionais, sem side effects, unit-testáveis.
// A Kirvano envia valores em BRL como string e datas em America/Sao_Paulo.
// A gente normaliza tudo pra centavos (Int) e Date UTC aqui.
// ============================================================

// ------------------------------------------------------------
// "R$ 169,80"         → 16980
// "R$ 1.234,56"       → 123456
// "R$1.234.567,89"    → 123456789
// "169,80"            → 16980
// ------------------------------------------------------------
export function parseBRLtoCents(str) {
  if (typeof str !== 'string' || !str.trim()) {
    throw new Error(`Valor BRL inválido: ${JSON.stringify(str)}`);
  }
  // Remove "R$", espaços e pontos de milhar; troca vírgula decimal por ponto
  const clean = str.replace(/R\$|\s|\./g, '').replace(',', '.');
  const v = Number.parseFloat(clean);
  if (Number.isNaN(v) || !Number.isFinite(v)) {
    throw new Error(`Valor BRL inválido: ${JSON.stringify(str)}`);
  }
  // Math.round pra evitar erro de ponto flutuante tipo 169.80 * 100 === 16979.999…
  return Math.round(v * 100);
}

// ------------------------------------------------------------
// Datas da Kirvano chegam sem timezone (ex: "2023-12-18 16:40:06")
// e referem-se ao horário de Brasília.
// Brasil aboliu o horário de verão em 2019 (Decreto 9.772), então
// America/Sao_Paulo é UTC-3 o ano todo.
// Retorna um Date em UTC equivalente.
// ------------------------------------------------------------
export function parseKirvanoDate(str) {
  if (typeof str !== 'string' || !str.trim()) {
    throw new Error(`Data Kirvano inválida: ${JSON.stringify(str)}`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(str.trim());
  if (!m) {
    throw new Error(`Data Kirvano em formato desconhecido: ${JSON.stringify(str)}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  // São Paulo = UTC-3 → soma 3h pra obter UTC
  return new Date(Date.UTC(y, mo - 1, d, h + 3, mi, s));
}

// ------------------------------------------------------------
// Mapa de eventos canônicos — só os que a gente efetivamente trata.
// Eventos fora desse mapa retornam null e são ignorados (log only).
//
// Referência: docs/kirvano-webhook.md
// ------------------------------------------------------------
const KIRVANO_EVENT_MAP = {
  // Vendas
  SALE_APPROVED: 'SALE_APPROVED',
  SALE_REFUNDED: 'SALE_REFUNDED',
  SALE_CHARGEBACK: 'SALE_CHARGEBACK',

  // Assinaturas
  SUBSCRIPTION_RENEWED: 'SUBSCRIPTION_RENEWED',
  SUBSCRIPTION_CANCELED: 'SUBSCRIPTION_CANCELED',
  SUBSCRIPTION_EXPIRED: 'SUBSCRIPTION_EXPIRED',

  // Pix (log only, sem ação nesse sprint)
  PIX_GENERATED: 'PIX_GENERATED',
  PIX_EXPIRED: 'PIX_EXPIRED',
};

export function mapKirvanoEvent(event) {
  if (typeof event !== 'string') return null;
  return KIRVANO_EVENT_MAP[event.toUpperCase()] || null;
}

// ------------------------------------------------------------
// Helper pra decidir qual plano aplicar quando o webhook chega.
// Usa offer_id se estiver no map ANNUAL_OFFER_IDS / MONTHLY_OFFER_IDS,
// senão cai no fallback por charge_frequency.
//
// Quando você souber os offer_ids reais da Kirvano, adicione aqui.
// ------------------------------------------------------------
const ANNUAL_OFFER_IDS = new Set([
  // TODO: preencher com offer_id real da Kirvano pro plano anual
]);
const MONTHLY_OFFER_IDS = new Set([
  // TODO: preencher com offer_id real da Kirvano pro plano mensal
]);

export function resolvePlanCode({ offerId, chargeFrequency }) {
  if (offerId && ANNUAL_OFFER_IDS.has(offerId)) return 'annual_v1';
  if (offerId && MONTHLY_OFFER_IDS.has(offerId)) return 'monthly_v1';
  // Fallback: charge_frequency em "ANNUALLY" | "MONTHLY" | "ONE_TIME"
  if (chargeFrequency === 'ANNUALLY') return 'annual_v1';
  return 'monthly_v1';
}
