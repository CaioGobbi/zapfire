// ============================================================
// GRANT SERVICE — operações de admin pra liberar/manter acesso
// ============================================================
// Concentra as ações que antes eram exclusividade do
// scripts/grant-access.js, agora também expostas via painel admin.
//
// Funções públicas:
//   - grantAccess({ ... })     → cria/anexa cortesia completa (user + sub + chave + email)
//   - setUserPassword({ ... }) → admin define/redefine senha de um user
//   - grantNewKey({ ... })     → cria nova sub ACTIVE + nova chave (ou reusa) pra user existente
//   - sendNewMagicLink({ ... })→ gera novo MAGIC_LINK e envia por email
//
// Padrão: cada função retorna `{ ok: true, ... }` ou `{ ok: false, code }`.
// Erros não-de-domínio (banco fora do ar etc) propagam — o endpoint
// captura e responde 500.
// ============================================================

import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

import { prisma } from '../lib/prisma.js';
import { generateSecureToken } from '../lib/tokens.js';
import { sendEmail } from '../lib/resend.js';

const MAGIC_LINK_TTL_DAYS = 7;

function panelBaseUrl() {
  return (process.env.PANEL_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

function genKeyValue() {
  return crypto.randomUUID().replace(/-/g, '');
}

function maskKey(keyValue) {
  return keyValue.match(/.{1,8}/g).join(' ');
}

function nameFromEmail(email) {
  const local = email.split('@')[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ------------------------------------------------------------
// Templates de email — minimalistas, inline-styled, igual padrão
// existente do kirvanoService (p/ chegada confiável no Gmail).
// ------------------------------------------------------------

function emailShell(innerHtml) {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fff;color:#171717;">
  ${innerHtml}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">
  <p style="font-size:12px;color:#737373;margin:0;">Dúvidas? Responda este email.</p>
</div>`;
}

function buildGrantWelcomeEmail({ name, planName, keyValue, magicLinkUrl, dias, hasPassword }) {
  const keyMasked = maskKey(keyValue);
  const deadline = new Date(Date.now() + dias * 86400_000).toLocaleDateString('pt-BR');
  const panel = panelBaseUrl();

  const cta = magicLinkUrl
    ? `<p style="margin:0 0 12px;">Pra começar, configure sua senha clicando abaixo:</p>
       <div style="text-align:center;margin:24px 0;">
         <a href="${magicLinkUrl}" style="display:inline-block;background:#ff3b30;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Configurar senha</a>
       </div>`
    : hasPassword
      ? `<p style="margin:0 0 12px;">Você já tem acesso ao painel — entre em <a href="${panel}/login" style="color:#ff3b30;">${panel}/login</a>.</p>`
      : `<p style="margin:0 0 12px;">Faça login em <a href="${panel}/login" style="color:#ff3b30;">${panel}/login</a>.</p>`;

  const html = emailShell(`
    <div style="text-align:center;margin-bottom:24px;">
      <div style="display:inline-block;width:48px;height:48px;background:#ff3b30;border-radius:10px;line-height:48px;font-weight:900;font-size:24px;color:#fff;">Z</div>
      <h1 style="font-size:22px;margin:12px 0 0;">Acesso liberado no Zapfire</h1>
    </div>
    <p style="margin:0 0 12px;">Olá <strong>${escapeHtml(name)}</strong>, seu acesso <strong>${escapeHtml(planName)}</strong> foi liberado.</p>
    ${cta}
    <div style="background:#fafafa;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;font-size:12px;color:#737373;">Sua chave de acesso:</p>
      <code style="display:block;font-family:monospace;font-size:14px;word-break:break-all;color:#171717;">${keyMasked}</code>
      <p style="margin:10px 0 0;font-size:12px;color:#737373;">Cole no popup da extensão. Válida até <strong>${deadline}</strong>.</p>
    </div>
  `);

  const text = [
    `Acesso liberado no Zapfire`,
    ``,
    `Olá ${name}, seu acesso ${planName} foi liberado.`,
    ``,
    magicLinkUrl ? `Configure sua senha: ${magicLinkUrl}` : `Login: ${panel}/login`,
    ``,
    `Chave: ${keyValue}`,
    `Válida até ${deadline}.`,
  ].join('\n');

  return { subject: 'Seu acesso ao Zapfire foi liberado', html, text };
}

function buildMagicLinkEmail({ name, magicLinkUrl }) {
  const html = emailShell(`
    <div style="text-align:center;margin-bottom:24px;">
      <div style="display:inline-block;width:48px;height:48px;background:#ff3b30;border-radius:10px;line-height:48px;font-weight:900;font-size:24px;color:#fff;">Z</div>
      <h1 style="font-size:22px;margin:12px 0 0;">Configure sua senha do Zapfire</h1>
    </div>
    <p style="margin:0 0 12px;">Olá <strong>${escapeHtml(name)}</strong>, clique abaixo pra configurar (ou redefinir) sua senha do painel.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${magicLinkUrl}" style="display:inline-block;background:#ff3b30;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Configurar senha</a>
    </div>
    <p style="margin:0 0 12px;font-size:12px;color:#737373;">Esse link é válido por 7 dias e só pode ser usado uma vez.</p>
  `);

  const text = `Configure sua senha do Zapfire\n\nOlá ${name},\n\n${magicLinkUrl}\n\nLink válido por 7 dias.`;

  return { subject: 'Configure sua senha do Zapfire', html, text };
}

function buildNewKeyEmail({ name, planName, keyValue, dias }) {
  const keyMasked = maskKey(keyValue);
  const deadline = new Date(Date.now() + dias * 86400_000).toLocaleDateString('pt-BR');

  const html = emailShell(`
    <div style="text-align:center;margin-bottom:24px;">
      <div style="display:inline-block;width:48px;height:48px;background:#ff3b30;border-radius:10px;line-height:48px;font-weight:900;font-size:24px;color:#fff;">Z</div>
      <h1 style="font-size:22px;margin:12px 0 0;">Nova chave de acesso</h1>
    </div>
    <p style="margin:0 0 12px;">Olá <strong>${escapeHtml(name)}</strong>, uma nova assinatura <strong>${escapeHtml(planName)}</strong> foi criada na sua conta.</p>
    <div style="background:#fafafa;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;font-size:12px;color:#737373;">Nova chave de acesso:</p>
      <code style="display:block;font-family:monospace;font-size:14px;word-break:break-all;color:#171717;">${keyMasked}</code>
      <p style="margin:10px 0 0;font-size:12px;color:#737373;">Cole no popup da extensão. Válida até <strong>${deadline}</strong>.</p>
    </div>
  `);

  const text = [
    `Nova chave de acesso no Zapfire`,
    ``,
    `Olá ${name}, uma nova assinatura ${planName} foi criada.`,
    ``,
    `Chave: ${keyValue}`,
    `Válida até ${deadline}.`,
  ].join('\n');

  return { subject: 'Nova chave de acesso no Zapfire', html, text };
}

// ============================================================
// 1. grantAccess — fluxo completo de cortesia
// ============================================================
//
// Cria User (ou reusa se já existe) + Subscription `manual`
// + AccessKey (ou reusa se user já tem ativa) + opcional
// magic link + email. Equivalente UI do scripts/grant-access.js.
//
// Args:
//   email          (string, required)
//   dias           (number, default 365)
//   planCode       (string, default 'monthly_v1')
//   nome           (string, opcional — derivado do email se ausente)
//   label          (string, opcional — `${nome} - cortesia` se ausente)
//   senha          (string, opcional — se passar, pula magic link)
//   sendEmail      (boolean, default true — manda email/magic link)
//   forceNewKey    (boolean, default false — força nova chave mesmo se user já tem)
//
// Retorna:
//   { ok: true, user, subscription, accessKey, plan,
//     magicLinkUrl?, emailResult?, userIsNew, keyReused }
//   ou { ok: false, code: 'PLAN_NOT_FOUND' | ... }
// ============================================================
export async function grantAccess({
  email,
  dias = 365,
  planCode = 'monthly_v1',
  nome,
  label,
  senha = null,
  sendEmail: shouldSendEmail = true,
  forceNewKey = false,
}) {
  if (!email || typeof email !== 'string') {
    return { ok: false, code: 'EMAIL_REQUIRED' };
  }
  email = email.toLowerCase().trim();

  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) return { ok: false, code: 'PLAN_NOT_FOUND' };

  const finalName = nome || nameFromEmail(email);
  const finalLabel = label || `${finalName} - cortesia`;

  let user = await prisma.user.findUnique({ where: { email } });
  let userIsNew = false;

  if (!user) {
    userIsNew = true;
    const placeholderHash = senha
      ? await bcrypt.hash(senha, 10)
      : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: placeholderHash,
        fullName: finalName,
        role: 'CUSTOMER',
        emailVerified: true,
        passwordSetAt: senha ? new Date() : null,
      },
    });
  } else if (senha && !user.passwordSetAt) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(senha, 10),
        passwordSetAt: new Date(),
        emailVerified: true,
      },
    });
  }

  const now = new Date();
  const end = new Date(now.getTime() + dias * 86400_000);
  const subscription = await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      status: 'ACTIVE',
      gatewayProvider: 'manual',
      startedAt: now,
      currentPeriodEnd: end,
    },
  });

  let accessKey;
  let keyReused = false;

  if (!forceNewKey) {
    const existingActive = await prisma.accessKey.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (existingActive) {
      accessKey = await prisma.accessKey.update({
        where: { id: existingActive.id },
        data: { subscriptionId: subscription.id },
      });
      keyReused = true;
    }
  }

  if (!accessKey) {
    accessKey = await prisma.accessKey.create({
      data: {
        userId: user.id,
        subscriptionId: subscription.id,
        keyValue: genKeyValue(),
        label: finalLabel,
      },
    });
  }

  let magicLinkUrl = null;
  if (userIsNew && !senha) {
    const { plaintext, hash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_DAYS * 86400_000);
    await prisma.emailToken.create({
      data: { userId: user.id, type: 'MAGIC_LINK', tokenHash: hash, expiresAt },
    });
    magicLinkUrl = `${panelBaseUrl()}/primeiro-acesso?token=${plaintext}`;
  }

  let emailResult = null;
  if (shouldSendEmail) {
    const tpl = buildGrantWelcomeEmail({
      name: finalName,
      planName: plan.name,
      keyValue: accessKey.keyValue,
      magicLinkUrl,
      dias,
      hasPassword: !!user.passwordSetAt,
    });
    emailResult = await sendEmail({ to: email, ...tpl });
  }

  return {
    ok: true,
    user,
    subscription,
    accessKey,
    plan,
    magicLinkUrl,
    emailResult,
    userIsNew,
    keyReused,
  };
}

// ============================================================
// 2. setUserPassword — admin define/redefine senha
// ============================================================
//
// Args: { userId, senha }
// Retorna: { ok: true, user } ou { ok: false, code }
// ============================================================
export async function setUserPassword({ userId, senha }) {
  if (!userId || !senha) return { ok: false, code: 'BAD_INPUT' };
  if (senha.length < 8) return { ok: false, code: 'PASSWORD_TOO_SHORT' };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' };

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await bcrypt.hash(senha, 10),
      passwordSetAt: new Date(),
      emailVerified: true,
    },
  });

  // Revoga todos os refresh tokens ativos (força re-login)
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return { ok: true, user: updated };
}

// ============================================================
// 3. grantNewKey — nova subscription + nova chave pra user existente
// ============================================================
//
// Diferente do grantAccess: SEMPRE cria nova chave (não reusa),
// pressupõe que o user já existe, NÃO envia magic link.
// Manda email avisando da nova chave (a menos que sendEmail=false).
//
// Args: { userId, dias, planCode, label?, sendEmail? }
// ============================================================
export async function grantNewKey({
  userId,
  dias = 365,
  planCode = 'monthly_v1',
  label,
  sendEmail: shouldSendEmail = true,
}) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' };

  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) return { ok: false, code: 'PLAN_NOT_FOUND' };

  const now = new Date();
  const end = new Date(now.getTime() + dias * 86400_000);
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      status: 'ACTIVE',
      gatewayProvider: 'manual',
      startedAt: now,
      currentPeriodEnd: end,
    },
  });

  const accessKey = await prisma.accessKey.create({
    data: {
      userId,
      subscriptionId: subscription.id,
      keyValue: genKeyValue(),
      label: label || `${user.fullName || nameFromEmail(user.email)} - chave admin`,
    },
  });

  let emailResult = null;
  if (shouldSendEmail) {
    const tpl = buildNewKeyEmail({
      name: user.fullName || nameFromEmail(user.email),
      planName: plan.name,
      keyValue: accessKey.keyValue,
      dias,
    });
    emailResult = await sendEmail({ to: user.email, ...tpl });
  }

  return { ok: true, user, subscription, accessKey, plan, emailResult };
}

// ============================================================
// 4. sendNewMagicLink — gera novo token e envia por email
// ============================================================
//
// Útil quando: cliente perdeu o email original, magic link expirou
// (7d), ou a senha precisa ser redefinida e o cliente prefere fazer
// pelo link em vez do admin definir manualmente.
//
// Args: { userId }
// Retorna: { ok: true, magicLinkUrl, emailResult } ou { ok: false, code }
// ============================================================
export async function sendNewMagicLink({ userId }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' };

  const { plaintext, hash } = generateSecureToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_DAYS * 86400_000);

  await prisma.emailToken.create({
    data: { userId, type: 'MAGIC_LINK', tokenHash: hash, expiresAt },
  });

  const magicLinkUrl = `${panelBaseUrl()}/primeiro-acesso?token=${plaintext}`;
  const tpl = buildMagicLinkEmail({
    name: user.fullName || nameFromEmail(user.email),
    magicLinkUrl,
  });
  const emailResult = await sendEmail({ to: user.email, ...tpl });

  return { ok: true, user, magicLinkUrl, emailResult };
}
