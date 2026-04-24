// ============================================================
// KIRVANO SERVICE — handlers por evento de webhook
// ============================================================
// Isolado do route handler pra ser testável sem o HTTP stack.
// Cada função aqui é idempotente: chamada 2× com mesmo sale_id
// é no-op na segunda chamada (verifica Payment.kirvanoSaleId).
//
// IMPORTANTE: nenhuma função aqui pode lançar exceção não tratada.
// Se algo der errado, loga em audit_logs com action "webhook.error"
// e retorna { ok: false, reason }. A rota responde 200 pra Kirvano
// mesmo em falha interna (evita retry loop).
// ============================================================

import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

import { prisma } from '../lib/prisma.js';
import { generateKeyValue } from './keyService.js';
import { generateSecureToken } from '../lib/tokens.js';
import { parseBRLtoCents, parseKirvanoDate, resolvePlanCode } from '../lib/kirvanoParser.js';
import { sendEmail } from '../lib/resend.js';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function panelBaseUrl() {
  return (process.env.PANEL_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

function parseAmountFromPayload(payload) {
  const raw = payload?.payment?.total_amount || payload?.total_price || '0';
  try {
    return parseBRLtoCents(raw);
  } catch {
    return 0;
  }
}

function parseNextCharge(payload) {
  const ncd = payload?.plan?.next_charge_date;
  if (!ncd) return null;
  // Kirvano pode mandar só data "2024-05-24" ou data+hora
  const s = /\d{2}:\d{2}/.test(ncd) ? ncd : `${ncd} 00:00:00`;
  try {
    return parseKirvanoDate(s);
  } catch {
    return null;
  }
}

async function logAudit(data) {
  try {
    await prisma.auditLog.create({ data });
  } catch (err) {
    console.error('[kirvano:auditLog]', err.message);
  }
}

// Lookup de subscription tolerante: tenta pelo kirvanoSaleId,
// depois pelo gatewaySubId (subscription.id da Kirvano).
async function findSubscription(payload) {
  const saleId = payload?.sale_id;
  const subId = payload?.subscription?.id;

  // 1. Pelo saleId original (funciona pra SALE_APPROVED posterior)
  if (saleId) {
    const bySale = await prisma.subscription.findUnique({ where: { kirvanoSaleId: saleId } });
    if (bySale) return bySale;
  }
  // 2. Pelo subscription.id (funciona pra renovações, cancels, etc)
  if (subId) {
    const bySub = await prisma.subscription.findUnique({ where: { gatewaySubId: subId } });
    if (bySub) return bySub;
  }
  return null;
}

// ------------------------------------------------------------
// SALE_APPROVED — primeira venda ou one-time
// ------------------------------------------------------------
export async function processSaleApproved(payload) {
  const saleId = payload.sale_id;

  // Idempotência — se já existe Payment com esse saleId, não reprocessa
  const existing = await prisma.payment.findUnique({ where: { kirvanoSaleId: saleId } });
  if (existing) {
    return { ok: true, skipped: 'already_processed' };
  }

  const email = String(payload.customer.email).toLowerCase().trim();
  const name = payload.customer.name?.trim() || email.split('@')[0];

  // 1. Upsert user — se novo, senha aleatória + emailVerified false
  //    (o cliente vai setar a senha real via magic link no painel)
  let user = await prisma.user.findUnique({ where: { email } });
  let isNewUser = false;
  if (!user) {
    const randomPassword = crypto.randomBytes(24).toString('hex');
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(randomPassword, 12),
        fullName: name,
        phone: payload.customer.phone_number || null,
        cpfCnpj: payload.customer.document || null,
        emailVerified: false,
        role: 'CUSTOMER',
      },
    });
    isNewUser = true;
  }

  // 2. Identifica plano
  const offerId = payload.products?.[0]?.offer_id;
  const chargeFrequency = payload.plan?.charge_frequency;
  const planCode = resolvePlanCode({ offerId, chargeFrequency });
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) {
    await logAudit({
      userId: user.id,
      action: 'webhook.error',
      metadata: { event: 'SALE_APPROVED', saleId, reason: `plan ${planCode} not found` },
    });
    return { ok: false, reason: `plan_not_found:${planCode}` };
  }

  // 3. Calcula currentPeriodEnd
  let currentPeriodEnd = parseNextCharge(payload);
  if (!currentPeriodEnd) {
    // Fallback: one-time → now + 30d/365d conforme plan.billingCycle
    const days = plan.billingCycle === 'ANNUAL' ? 365 : 30;
    currentPeriodEnd = new Date(Date.now() + days * 86400000);
  }

  // 4. Cria Subscription
  const subscription = await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      status: 'ACTIVE',
      gatewayProvider: 'kirvano',
      gatewaySubId: payload.subscription?.id || null,
      kirvanoSaleId: saleId,
      kirvanoStatus: payload.status || null,
      startedAt: new Date(),
      currentPeriodEnd,
      gracePeriodEndsAt: null,
    },
  });

  // 5. Gera AccessKey
  const keyValue = generateKeyValue();
  const accessKey = await prisma.accessKey.create({
    data: {
      userId: user.id,
      subscriptionId: subscription.id,
      keyValue,
      label: name,
    },
  });

  // 6. Cria Payment
  const amountCents = parseAmountFromPayload(payload);
  const paidAt = payload.finished_at ? (() => {
    try { return parseKirvanoDate(payload.finished_at); } catch { return new Date(); }
  })() : new Date();

  await prisma.payment.create({
    data: {
      subscriptionId: subscription.id,
      gatewayProvider: 'kirvano',
      gatewayPaymentId: saleId,
      kirvanoSaleId: saleId,
      paidAmountCents: amountCents,
      status: 'PAID',
      paymentMethod: payload.payment?.method || payload.payment_method || null,
      paidAt,
      rawWebhookPayload: payload,
    },
  });

  // 7. Gera EmailToken MAGIC_LINK (7 dias)
  const { plaintext: magicPlain, hash: magicHash } = generateSecureToken();
  const magicToken = await prisma.emailToken.create({
    data: {
      userId: user.id,
      type: 'MAGIC_LINK',
      tokenHash: magicHash,
      expiresAt: new Date(Date.now() + 7 * 86400000),
    },
  });

  // 8. Envia email de boas-vindas e salva resendEmailId (Sprint 6 — pra tracking de bounce)
  const magicLinkUrl = `${panelBaseUrl()}/primeiro-acesso?token=${magicPlain}`;
  const emailResult = await sendWelcomeEmail({
    to: email,
    name,
    planName: plan.name,
    keyValue,
    magicLinkUrl,
  });
  if (emailResult?.id) {
    await prisma.emailToken.update({
      where: { id: magicToken.id },
      data: {
        resendEmailId: emailResult.id,
        deliveryStatus: 'sent',
        deliveryUpdatedAt: new Date(),
      },
    });
  }

  // 9. Audit log
  await logAudit({
    userId: user.id,
    action: 'subscription.created',
    entityType: 'Subscription',
    entityId: subscription.id,
    metadata: { kirvanoSaleId: saleId, planCode, isNewUser, accessKeyId: accessKey.id },
  });

  return { ok: true, processed: 'SALE_APPROVED', subscriptionId: subscription.id };
}

// ------------------------------------------------------------
// SUBSCRIPTION_RENEWED — renovação recorrente
// ------------------------------------------------------------
export async function processSubscriptionRenewed(payload) {
  const saleId = payload.sale_id;

  // Idempotência pelo saleId da renovação (NÃO pelo saleId original)
  const existingPayment = await prisma.payment.findUnique({ where: { kirvanoSaleId: saleId } });
  if (existingPayment) {
    return { ok: true, skipped: 'already_processed' };
  }

  const subscription = await findSubscription(payload);
  if (!subscription) {
    await logAudit({
      action: 'webhook.error',
      metadata: { event: 'SUBSCRIPTION_RENEWED', saleId, reason: 'subscription_not_found' },
    });
    return { ok: false, reason: 'subscription_not_found' };
  }

  const nextCharge = parseNextCharge(payload) ||
    new Date(subscription.currentPeriodEnd.getTime() + 30 * 86400000);

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      status: 'ACTIVE',
      currentPeriodEnd: nextCharge,
      gracePeriodEndsAt: null,
      kirvanoStatus: payload.status || subscription.kirvanoStatus,
    },
  });

  const amountCents = parseAmountFromPayload(payload);
  await prisma.payment.create({
    data: {
      subscriptionId: subscription.id,
      gatewayProvider: 'kirvano',
      gatewayPaymentId: saleId,
      kirvanoSaleId: saleId,
      paidAmountCents: amountCents,
      status: 'PAID',
      paymentMethod: payload.payment?.method || null,
      paidAt: new Date(),
      rawWebhookPayload: payload,
    },
  });

  // Email simples de confirmação
  const user = await prisma.user.findUnique({ where: { id: subscription.userId } });
  if (user) {
    await sendRenewalEmail({
      to: user.email,
      name: user.fullName,
      nextChargeDate: nextCharge,
      amountCents,
    });
  }

  await logAudit({
    userId: subscription.userId,
    action: 'subscription.renewed',
    entityType: 'Subscription',
    entityId: subscription.id,
    metadata: { kirvanoSaleId: saleId, nextCharge: nextCharge.toISOString() },
  });

  return { ok: true, processed: 'SUBSCRIPTION_RENEWED', subscriptionId: subscription.id };
}

// ------------------------------------------------------------
// SUBSCRIPTION_CANCELED — cancelado pelo usuário
// NÃO bloqueia — acesso continua até currentPeriodEnd.
// ------------------------------------------------------------
export async function processSubscriptionCanceled(payload) {
  const subscription = await findSubscription(payload);
  if (!subscription) {
    return { ok: false, reason: 'subscription_not_found' };
  }

  if (subscription.status === 'CANCELED') {
    return { ok: true, skipped: 'already_canceled' };
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      status: 'CANCELED',
      canceledAt: new Date(),
      cancelReason: payload.reason || 'Cancelado pelo cliente',
      kirvanoStatus: payload.status || subscription.kirvanoStatus,
    },
  });

  const user = await prisma.user.findUnique({ where: { id: subscription.userId } });
  if (user) {
    await sendCancelationEmail({
      to: user.email,
      name: user.fullName,
      expiresAt: subscription.currentPeriodEnd,
    });
  }

  await logAudit({
    userId: subscription.userId,
    action: 'subscription.canceled',
    entityType: 'Subscription',
    entityId: subscription.id,
    metadata: { expiresAt: subscription.currentPeriodEnd.toISOString() },
  });

  return { ok: true, processed: 'SUBSCRIPTION_CANCELED', subscriptionId: subscription.id };
}

// ------------------------------------------------------------
// SUBSCRIPTION_EXPIRED — expirou sem renovação
// ------------------------------------------------------------
export async function processSubscriptionExpired(payload) {
  const subscription = await findSubscription(payload);
  if (!subscription) {
    return { ok: false, reason: 'subscription_not_found' };
  }

  if (subscription.status === 'EXPIRED') {
    return { ok: true, skipped: 'already_expired' };
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      status: 'EXPIRED',
      kirvanoStatus: payload.status || subscription.kirvanoStatus,
    },
  });

  await logAudit({
    userId: subscription.userId,
    action: 'subscription.expired',
    entityType: 'Subscription',
    entityId: subscription.id,
    metadata: {},
  });

  return { ok: true, processed: 'SUBSCRIPTION_EXPIRED', subscriptionId: subscription.id };
}

// ------------------------------------------------------------
// SALE_REFUNDED / SALE_CHARGEBACK — bloqueia chave
// ------------------------------------------------------------
export async function processSaleRefundOrChargeback(payload, kind) {
  // kind: 'REFUND' | 'CHARGEBACK'
  const saleId = payload.sale_id;

  const payment = await prisma.payment.findUnique({
    where: { kirvanoSaleId: saleId },
    include: { subscription: { include: { keys: true, user: true } } },
  });
  if (!payment) {
    // Possível: webhook de refund chegou antes do SALE_APPROVED. Raro. Log e segue.
    await logAudit({
      action: 'webhook.error',
      metadata: { event: kind === 'REFUND' ? 'SALE_REFUNDED' : 'SALE_CHARGEBACK', saleId, reason: 'payment_not_found' },
    });
    return { ok: false, reason: 'payment_not_found' };
  }

  const newPaymentStatus = kind === 'REFUND' ? 'REFUNDED' : 'CHARGEBACK';
  if (payment.status === newPaymentStatus) {
    return { ok: true, skipped: 'already_processed' };
  }

  // Atualiza Payment
  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: newPaymentStatus },
  });

  // Marca subscription + bloqueia todas as keys
  await prisma.subscription.update({
    where: { id: payment.subscriptionId },
    data: {
      status: 'BLOCKED',
      cancelReason: kind === 'REFUND' ? 'Reembolsado' : 'Chargeback',
      kirvanoStatus: payload.status || null,
    },
  });

  for (const key of payment.subscription.keys) {
    await prisma.accessKey.update({
      where: { id: key.id },
      data: {
        status: 'BLOCKED',
        blockedReason: kind,
        blockedAt: new Date(),
      },
    });
  }

  // Email
  if (payment.subscription.user) {
    await sendChargebackEmail({
      to: payment.subscription.user.email,
      name: payment.subscription.user.fullName,
      kind,
    });
  }

  await logAudit({
    userId: payment.subscription.userId,
    action: kind === 'REFUND' ? 'key.refund_blocked' : 'key.chargeback_blocked',
    entityType: 'Subscription',
    entityId: payment.subscriptionId,
    metadata: { kirvanoSaleId: saleId, blockedKeys: payment.subscription.keys.length },
  });

  return { ok: true, processed: kind === 'REFUND' ? 'SALE_REFUNDED' : 'SALE_CHARGEBACK' };
}

// ------------------------------------------------------------
// Email templates (inline — movidos pra docs/email-templates.md depois)
// ------------------------------------------------------------

const EMAIL_STYLES = {
  body: "margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;",
  wrap: 'max-width:520px;margin:0 auto;padding:32px 24px;',
  logo: 'display:inline-block;width:48px;height:48px;border-radius:10px;background:#ff3b30;color:#fff;font-weight:700;font-size:28px;line-height:48px;text-align:center;',
  h1:   'font-size:22px;margin:16px 0 0;color:#f5f5f5;',
  p:    'font-size:15px;line-height:1.6;color:#d4d4d4;',
  dim:  'font-size:13px;color:#a3a3a3;',
  btn:  'display:inline-block;padding:12px 28px;background:#ff3b30;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;',
  hr:   'border:none;border-top:1px solid #262626;margin:24px 0;',
  code: "background:#141414;border:1px solid #262626;border-radius:6px;padding:14px;font-family:'SF Mono',Menlo,monospace;font-size:14px;color:#ff3b30;word-break:break-all;",
};

function emailShell(innerHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="${EMAIL_STYLES.body}"><div style="${EMAIL_STYLES.wrap}">${innerHtml}</div></body></html>`;
}

async function sendWelcomeEmail({ to, name, planName, keyValue, magicLinkUrl }) {
  const html = emailShell(`
    <div style="text-align:center;margin-bottom:16px;"><div style="${EMAIL_STYLES.logo}">Z</div><h1 style="${EMAIL_STYLES.h1}">Bem-vindo ao Zapfire</h1></div>
    <p style="${EMAIL_STYLES.p}">Olá <strong>${escapeHtml(name)}</strong>, sua assinatura <strong>${escapeHtml(planName)}</strong> foi ativada.</p>
    <p style="${EMAIL_STYLES.p}">Pra começar, configure sua senha clicando abaixo:</p>
    <div style="text-align:center;margin:28px 0;"><a href="${magicLinkUrl}" style="${EMAIL_STYLES.btn}">Configurar senha</a></div>
    <p style="${EMAIL_STYLES.dim}">Esse link expira em 7 dias.</p>
    <hr style="${EMAIL_STYLES.hr}">
    <p style="${EMAIL_STYLES.p};margin-bottom:8px;">Sua chave de acesso:</p>
    <div style="${EMAIL_STYLES.code}">${escapeHtml(keyValue)}</div>
    <p style="${EMAIL_STYLES.dim};margin-top:12px;">Cole essa chave no popup da extensão Chrome após instalá-la.</p>
    <hr style="${EMAIL_STYLES.hr}">
    <p style="font-size:12px;color:#737373;margin:0;">Dúvidas? Responda este email.</p>
  `);
  const text = `Bem-vindo ao Zapfire!

Sua assinatura ${planName} foi ativada.

Configure sua senha: ${magicLinkUrl}
(expira em 7 dias)

Chave de acesso:
${keyValue}

Cole no popup da extensão Chrome.`;

  return sendEmail({ to, subject: 'Bem-vindo ao Zapfire — configure sua senha', html, text });
}

async function sendRenewalEmail({ to, name, nextChargeDate, amountCents }) {
  const valor = (amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const nextStr = nextChargeDate.toLocaleDateString('pt-BR');
  const html = emailShell(`
    <div style="text-align:center;margin-bottom:16px;"><div style="${EMAIL_STYLES.logo}">Z</div><h1 style="${EMAIL_STYLES.h1}">Renovação confirmada</h1></div>
    <p style="${EMAIL_STYLES.p}">Olá <strong>${escapeHtml(name)}</strong>, recebemos o pagamento de <strong>${valor}</strong>.</p>
    <p style="${EMAIL_STYLES.p}">Próxima cobrança: <strong>${nextStr}</strong>.</p>
    <p style="${EMAIL_STYLES.dim}">Sua chave continua a mesma.</p>
  `);
  const text = `Renovação confirmada — pagamento de ${valor}. Próxima cobrança: ${nextStr}.`;
  return sendEmail({ to, subject: 'Zapfire — renovação confirmada', html, text });
}

async function sendCancelationEmail({ to, name, expiresAt }) {
  const dt = expiresAt.toLocaleDateString('pt-BR');
  const html = emailShell(`
    <div style="text-align:center;margin-bottom:16px;"><div style="${EMAIL_STYLES.logo}">Z</div><h1 style="${EMAIL_STYLES.h1}">Assinatura cancelada</h1></div>
    <p style="${EMAIL_STYLES.p}">Olá <strong>${escapeHtml(name)}</strong>, seu cancelamento foi processado.</p>
    <p style="${EMAIL_STYLES.p}">Você mantém acesso até <strong>${dt}</strong>. Se mudar de ideia, é só reativar pela Kirvano.</p>
  `);
  const text = `Cancelamento processado. Acesso mantido até ${dt}.`;
  return sendEmail({ to, subject: 'Zapfire — assinatura cancelada', html, text });
}

async function sendChargebackEmail({ to, name, kind }) {
  const motivo = kind === 'REFUND' ? 'reembolso' : 'chargeback';
  const html = emailShell(`
    <div style="text-align:center;margin-bottom:16px;"><div style="${EMAIL_STYLES.logo}">Z</div><h1 style="${EMAIL_STYLES.h1}">Acesso suspenso</h1></div>
    <p style="${EMAIL_STYLES.p}">Olá <strong>${escapeHtml(name)}</strong>, identificamos um <strong>${motivo}</strong> no seu pagamento, por isso sua chave foi bloqueada.</p>
    <p style="${EMAIL_STYLES.p}">Se foi engano, responda este email com o comprovante.</p>
  `);
  const text = `Acesso suspenso por ${motivo}. Se foi engano, responda este email.`;
  return sendEmail({ to, subject: 'Zapfire — acesso suspenso', html, text });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Export interno só pra testes isolados, se quiser
export const _internals = { parseAmountFromPayload, parseNextCharge, findSubscription };
