// ============================================================
// SEED — popular banco com dados iniciais pra desenvolvimento
// ============================================================
// Roda: npm run db:seed
// ============================================================

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🔥 Zapfire seed iniciado');

  // ---------- 1. Planos ----------
  // Mantém o monthly_x1 legado (usado pela chave de teste já em uso)
  // e adiciona os planos comerciais do Sprint 4: Mensal (R$47) e Anual (R$395)
  // Sprint 5 — features.tracking + features.dailyReport definem se o
  // plano libera o painel de Funis Monitorados + Relatórios. monthly_v1
  // e annual_v1 são "Free" pra essas features (false). pro_v1 é o plano
  // novo com tracking ligado.
  const FEATURES_FREE = {
    audioInjection: true,
    funnels: true,
    triggers: true,
    scheduling: true,
    multiDevice: true,
    tracking: false,         // Sprint 5
    dailyReport: false,      // Sprint 5
    maxMonitoredFunnels: 0,  // Sprint 5
  };
  const FEATURES_PRO = {
    ...FEATURES_FREE,
    tracking: true,
    dailyReport: true,
    maxMonitoredFunnels: 10,
  };

  const planLegacy = await prisma.plan.upsert({
    where: { code: 'monthly_x1' },
    update: { features: FEATURES_FREE },
    create: {
      code: 'monthly_x1',
      name: 'Mensal X1',
      description: 'Plano mensal para afiliados X1 (legado)',
      priceCents: 9700, // R$ 97
      billingCycle: 'MONTHLY',
      maxKeys: 1,
      maxDevicesPerKey: 4,
      features: FEATURES_FREE,
    },
  });
  console.log('✅ Plano legado:', planLegacy.code);

  const planMonthly = await prisma.plan.upsert({
    where: { code: 'monthly_v1' },
    update: {
      name: 'Mensal',
      priceCents: 4700,
      billingCycle: 'MONTHLY',
      maxDevicesPerKey: 4,
      features: FEATURES_FREE,
    },
    create: {
      code: 'monthly_v1',
      name: 'Mensal',
      description: 'Plano mensal Zapfire — R$47/mês, até 4 dispositivos',
      priceCents: 4700, // R$ 47
      billingCycle: 'MONTHLY',
      maxKeys: 1,
      maxDevicesPerKey: 4,
      features: FEATURES_FREE,
    },
  });
  console.log('✅ Plano mensal:', planMonthly.code, '— R$', (planMonthly.priceCents / 100).toFixed(2));

  const planAnnual = await prisma.plan.upsert({
    where: { code: 'annual_v1' },
    update: {
      name: 'Anual',
      priceCents: 39500,
      billingCycle: 'ANNUAL',
      maxDevicesPerKey: 4,
      features: FEATURES_FREE,
    },
    create: {
      code: 'annual_v1',
      name: 'Anual',
      description: 'Plano anual Zapfire — R$395 (≈30% OFF vs 12× mensal)',
      priceCents: 39500, // R$ 395
      billingCycle: 'ANNUAL',
      maxKeys: 1,
      maxDevicesPerKey: 4,
      features: FEATURES_FREE,
    },
  });
  console.log('✅ Plano anual: ', planAnnual.code, '— R$', (planAnnual.priceCents / 100).toFixed(2));

  // Sprint 5 — Plano Pro (tracking + relatórios). Preço placeholder R$97
  // até decisão final. Quando virar definitivo, atualizar aqui + criar
  // a oferta correspondente na Kirvano + adicionar offer_id em
  // backend/src/lib/kirvanoParser.js (PRO_OFFER_IDS).
  const planPro = await prisma.plan.upsert({
    where: { code: 'pro_v1' },
    update: {
      name: 'Pro',
      priceCents: 9700,  // PLACEHOLDER — definir preço final
      features: FEATURES_PRO,
    },
    create: {
      code: 'pro_v1',
      name: 'Pro',
      description: 'Zapfire Pro — Funis monitorados + relatórios automáticos no WhatsApp',
      priceCents: 9700, // PLACEHOLDER — R$97/mês até decisão final
      billingCycle: 'MONTHLY',
      maxKeys: 1,
      maxDevicesPerKey: 4,
      features: FEATURES_PRO,
    },
  });
  console.log('✅ Plano Pro:   ', planPro.code, '— R$', (planPro.priceCents / 100).toFixed(2), '(preço placeholder)');

  // Alias: chave de teste antiga continua apontando pro plano legado
  const plan = planLegacy;

  // ---------- 2. Admin ----------
  // Sprint 6 — admin precisa de `passwordSetAt` + `emailVerified` pro
  // /login direto funcionar (senão o gate PASSWORD_NOT_SET bloqueia).
  // Se já existe, NÃO sobrescreve a senha (pode ter sido mudada pelo admin).
  const admin = await prisma.user.upsert({
    where: { email: process.env.ADMIN_EMAIL || 'melfi@improvavel.com.br' },
    update: {
      role: 'ADMIN',
      isActive: true,
      emailVerified: true,
    },
    create: {
      email: process.env.ADMIN_EMAIL || 'melfi@improvavel.com.br',
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme', 10),
      fullName: 'Melfi (Admin)',
      role: 'ADMIN',
      emailVerified: true,
      passwordSetAt: new Date(),
    },
  });
  // Garante passwordSetAt mesmo em admins pré-existentes (sem tocar senha)
  if (!admin.passwordSetAt) {
    await prisma.user.update({
      where: { id: admin.id },
      data: { passwordSetAt: new Date() },
    });
  }
  console.log('✅ Admin:', admin.email, '(role: ADMIN)');

  // ---------- 3. Usuário de teste + chave ----------
  const testUser = await prisma.user.upsert({
    where: { email: 'teste@zapfire.com.br' },
    update: {},
    create: {
      email: 'teste@zapfire.com.br',
      passwordHash: await bcrypt.hash('teste123', 10),
      fullName: 'Caio Gobbi (Teste)',
      role: 'CUSTOMER',
    },
  });

  const testSub = await prisma.subscription.create({
    data: {
      userId: testUser.id,
      planId: plan.id,
      status: 'ACTIVE',
      gatewayProvider: 'manual',
      startedAt: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // +1 ano
    },
  });

  const testKeyValue = crypto.randomUUID().replace(/-/g, '');
  await prisma.accessKey.create({
    data: {
      userId: testUser.id,
      subscriptionId: testSub.id,
      keyValue: testKeyValue,
      label: 'Caio Gobbi',
    },
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('🔑 CHAVE DE TESTE GERADA:');
  console.log('   ', testKeyValue);
  console.log('   (cole essa chave no popup da extensão)');
  console.log('═══════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
