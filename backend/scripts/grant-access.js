// ============================================================
// GRANT ACCESS — cria cortesia (user + subscription + chave)
// ============================================================
// Uso pra liberar o sistema de graça pra alguém sem passar pela
// Kirvano. Cria User (ou reusa se já existe), Subscription com
// `gatewayProvider: 'manual'`, AccessKey pronta pra usar e, se
// for user novo, dispara magic link de primeiro acesso.
//
// Exemplos:
//   node scripts/grant-access.js --email=amigo@x.com --dias=365
//   node scripts/grant-access.js --email=amigo@x.com --plano=annual_v1 --nome="Fulano" --label="Fulano - cortesia"
//   node scripts/grant-access.js --email=amigo@x.com --dias=90 --senha=TemporariaForte2026
//   node scripts/grant-access.js --email=amigo@x.com --dias=365 --no-email
//
// Em prod (Railway), precisa do DATABASE_PUBLIC_URL pra conseguir
// falar com o Postgres de fora da rede deles:
//   DATABASE_URL=$DATABASE_PUBLIC_URL node scripts/grant-access.js --email=...
// ============================================================

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { generateSecureToken } from '../src/lib/tokens.js';
import { sendEmail, isMockMode } from '../src/lib/resend.js';

const prisma = new PrismaClient();

// ------------------------------------------------------------
// Parse CLI args — aceita --chave=valor e --chave valor
// Booleans: --no-email, --help, --force-new-key
// ------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[a.slice(2)] = next;
        i++;
      } else {
        args[a.slice(2)] = true;
      }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Uso: node scripts/grant-access.js [opções]

Opções:
  --email=<email>          (obrigatório) email do beneficiário
  --dias=<n>               dias de validade da assinatura (default: 365)
  --plano=<code>           código do plano (default: monthly_v1)
                           opções: monthly_v1, annual_v1, monthly_x1
  --nome=<nome>            nome completo (default: extraído do email)
  --label=<label>          nome amigável da chave no painel admin
                           (default: "<nome> - cortesia")
  --senha=<senha>          se informada, já deixa o cliente com senha
                           definida (pula magic link; cliente loga direto).
                           Útil pra entregar acesso por WhatsApp/Telegram.
  --no-email               não dispara email (útil pra testes)
  --force-new-key          força criar chave nova mesmo se o user já
                           tiver uma chave ativa (default: reusa)
  --help                   mostra esta ajuda

Exemplo:
  node scripts/grant-access.js --email=mentorado@x.com --dias=365
`);
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function genKeyValue() {
  return crypto.randomUUID().replace(/-/g, '');
}

function maskKey(keyValue) {
  // 8-8-8-8 pra leitura no terminal, mesmo agrupamento do painel
  return keyValue.match(/.{1,8}/g).join(' ');
}

function panelBaseUrl() {
  return (process.env.PANEL_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function nameFromEmail(email) {
  const local = email.split('@')[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// ------------------------------------------------------------
// Email — template minimalista com a chave + magic link (se novo)
// ou só a chave (se já tinha conta)
// ------------------------------------------------------------
async function sendGrantEmail({ email, name, planName, keyValue, magicLinkUrl, dias, hasPassword }) {
  const keyMasked = maskKey(keyValue);
  const deadline = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR');
  const panel = panelBaseUrl();

  const cta = magicLinkUrl
    ? `<p style="margin:0 0 12px;">Pra começar, configure sua senha clicando abaixo:</p>
       <div style="text-align:center;margin:24px 0;">
         <a href="${magicLinkUrl}" style="display:inline-block;background:#ff3b30;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Configurar senha</a>
       </div>`
    : hasPassword
      ? `<p style="margin:0 0 12px;">Você já tem acesso ao painel — entre em <a href="${panel}/login" style="color:#ff3b30;">${panel}/login</a>.</p>`
      : `<p style="margin:0 0 12px;">Faça login em <a href="${panel}/login" style="color:#ff3b30;">${panel}/login</a>.</p>`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fff;color:#171717;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;width:48px;height:48px;background:#ff3b30;border-radius:10px;line-height:48px;font-weight:900;font-size:24px;color:#fff;">Z</div>
        <h1 style="font-size:22px;margin:12px 0 0;">Acesso liberado no Zapfire</h1>
      </div>
      <p style="margin:0 0 12px;">Olá <strong>${escapeHtml(name)}</strong>, seu acesso <strong>${escapeHtml(planName)}</strong> foi liberado por cortesia.</p>
      ${cta}
      <div style="background:#fafafa;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:16px 0;">
        <p style="margin:0 0 8px;font-size:12px;color:#737373;">Sua chave de acesso:</p>
        <code style="display:block;font-family:monospace;font-size:14px;word-break:break-all;color:#171717;">${keyMasked}</code>
        <p style="margin:10px 0 0;font-size:12px;color:#737373;">Cole no popup da extensão. Válida até <strong>${deadline}</strong>.</p>
      </div>
      <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">
      <p style="font-size:12px;color:#737373;margin:0;">Dúvidas? Responda este email.</p>
    </div>
  `;

  const text = [
    `Acesso liberado no Zapfire`,
    ``,
    `Olá ${name}, seu acesso ${planName} foi liberado por cortesia.`,
    ``,
    magicLinkUrl ? `Configure sua senha: ${magicLinkUrl}` : `Login: ${panel}/login`,
    ``,
    `Chave de acesso:`,
    `   ${keyValue}`,
    ``,
    `Cole no popup da extensão. Válida até ${deadline}.`,
  ].join('\n');

  return sendEmail({
    to: email,
    subject: 'Seu acesso ao Zapfire foi liberado',
    html,
    text,
  });
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  // ---- Validações de input ----
  const email = (args.email || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('❌ --email é obrigatório e precisa ser válido');
    printHelp();
    process.exit(1);
  }

  const dias = parseInt(args.dias || '365', 10);
  if (!Number.isFinite(dias) || dias <= 0 || dias > 3650) {
    console.error('❌ --dias precisa ser um número entre 1 e 3650');
    process.exit(1);
  }

  const planCode = args.plano || 'monthly_v1';
  const nome = args.nome || nameFromEmail(email);
  const label = args.label || `${nome} - cortesia`;
  const senhaDefinida = args.senha || null;
  const pularEmail = args['no-email'] === true;
  const forceNewKey = args['force-new-key'] === true;

  // ---- Plano ----
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) {
    console.error(`❌ Plano não encontrado: ${planCode}`);
    console.error('   Planos disponíveis:');
    const all = await prisma.plan.findMany({ orderBy: { priceCents: 'asc' } });
    for (const p of all) console.error(`     - ${p.code} (${p.name}, R$${(p.priceCents / 100).toFixed(2)})`);
    process.exit(1);
  }

  // ---- User: cria ou reusa ----
  let user = await prisma.user.findUnique({ where: { email } });
  let userIsNew = false;

  if (!user) {
    userIsNew = true;
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: senhaDefinida
          ? await bcrypt.hash(senhaDefinida, 10)
          : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10), // placeholder inquebrável; magic link seta a real
        fullName: nome,
        role: 'CUSTOMER',
        emailVerified: true,
        passwordSetAt: senhaDefinida ? new Date() : null,
      },
    });
    console.log(`✅ Usuário criado: ${user.email}`);
  } else {
    console.log(`ℹ️  Usuário já existe: ${user.email} (id ${user.id})`);
    // Se passou --senha e o user não tinha senha setada, completa o setup
    if (senhaDefinida && !user.passwordSetAt) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await bcrypt.hash(senhaDefinida, 10),
          passwordSetAt: new Date(),
          emailVerified: true,
        },
      });
      console.log(`✅ Senha definida (user não tinha ainda)`);
    }
  }

  // ---- Subscription: cria sempre uma nova com provider 'manual' ----
  const now = new Date();
  const end = new Date(now.getTime() + dias * 24 * 60 * 60 * 1000);

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
  console.log(`✅ Assinatura criada: ${plan.name} — válida até ${end.toLocaleDateString('pt-BR')}`);

  // ---- Chave: reusa ativa ou cria nova ----
  let keyValue;
  let keyReused = false;

  if (!forceNewKey) {
    const existingActive = await prisma.accessKey.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (existingActive) {
      // Re-aponta a chave existente pra nova subscription (extende validade)
      await prisma.accessKey.update({
        where: { id: existingActive.id },
        data: { subscriptionId: subscription.id },
      });
      keyValue = existingActive.keyValue;
      keyReused = true;
      console.log(`ℹ️  Chave existente reaproveitada (boundPhone: ${existingActive.boundPhone || 'solta'})`);
    }
  }

  if (!keyValue) {
    keyValue = genKeyValue();
    await prisma.accessKey.create({
      data: {
        userId: user.id,
        subscriptionId: subscription.id,
        keyValue,
        label,
      },
    });
    console.log(`✅ Chave criada: ${label}`);
  }

  // ---- Audit log ----
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'access.granted_manually',
      entityType: 'Subscription',
      entityId: subscription.id,
      metadata: {
        planCode,
        dias,
        currentPeriodEnd: end.toISOString(),
        keyReused,
        userIsNew,
        hadSenhaDefinida: !!senhaDefinida,
        source: 'scripts/grant-access.js',
      },
    },
  });

  // ---- Magic link (se user novo sem senha) ----
  let magicLinkUrl = null;
  if (userIsNew && !senhaDefinida) {
    const { plaintext, hash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias
    await prisma.emailToken.create({
      data: {
        userId: user.id,
        type: 'MAGIC_LINK',
        tokenHash: hash,
        expiresAt,
      },
    });
    magicLinkUrl = `${panelBaseUrl()}/primeiro-acesso?token=${plaintext}`;
  }

  // ---- Email ----
  if (!pularEmail) {
    const emailResult = await sendGrantEmail({
      email,
      name: nome,
      planName: plan.name,
      keyValue,
      magicLinkUrl,
      dias,
      hasPassword: !!user.passwordSetAt,
    });
    if (emailResult.ok) {
      console.log(`✅ Email enviado${emailResult.mockMode ? ' (MOCK — RESEND_API_KEY vazio)' : ` (id: ${emailResult.id})`}`);
    } else {
      console.warn(`⚠️  Falha no envio de email: ${emailResult.error}`);
    }
  } else {
    console.log('ℹ️  Email pulado (--no-email)');
  }

  // ---- Resumo final ----
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔑 ACESSO DE CORTESIA LIBERADO');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`   Email    : ${email}`);
  console.log(`   Nome     : ${nome}`);
  console.log(`   Plano    : ${plan.name} (${plan.code})`);
  console.log(`   Válido até: ${end.toLocaleDateString('pt-BR')} (${dias} dias)`);
  console.log(`   Chave    : ${maskKey(keyValue)}`);
  console.log(`              ${keyValue}`);
  if (magicLinkUrl) {
    console.log(`   Magic link (expira em 7d):`);
    console.log(`     ${magicLinkUrl}`);
  }
  if (senhaDefinida) {
    console.log(`   Senha    : (definida — cliente pode logar direto em ${panelBaseUrl()}/login)`);
  }
  if (isMockMode() && !pularEmail) {
    console.log('');
    console.log('   ⚠️  Email em modo mock — entregue a chave/link manualmente.');
  }
  console.log('═══════════════════════════════════════════════════════════════════');
}

main()
  .catch((err) => {
    console.error('');
    console.error('❌ Erro:', err.message);
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
