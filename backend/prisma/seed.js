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
  const planLegacy = await prisma.plan.upsert({
    where: { code: 'monthly_x1' },
    update: {},
    create: {
      code: 'monthly_x1',
      name: 'Mensal X1',
      description: 'Plano mensal para afiliados X1 (legado)',
      priceCents: 9700, // R$ 97
      billingCycle: 'MONTHLY',
      maxKeys: 1,
      maxDevicesPerKey: 4,
      features: {
        audioInjection: true,
        funnels: true,
        triggers: true,
        scheduling: true,
        multiDevice: true,
      },
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
    },
    create: {
      code: 'monthly_v1',
      name: 'Mensal',
      description: 'Plano mensal Zapfire — R$47/mês, até 4 dispositivos',
      priceCents: 4700, // R$ 47
      billingCycle: 'MONTHLY',
      maxKeys: 1,
      maxDevicesPerKey: 4,
      features: {
        audioInjection: true,
        funnels: true,
        triggers: true,
        scheduling: true,
        multiDevice: true,
      },
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
    },
    create: {
      code: 'annual_v1',
      name: 'Anual',
      description: 'Plano anual Zapfire — R$395 (≈30% OFF vs 12× mensal)',
      priceCents: 39500, // R$ 395
      billingCycle: 'ANNUAL',
      maxKeys: 1,
      maxDevicesPerKey: 4,
      features: {
        audioInjection: true,
        funnels: true,
        triggers: true,
        scheduling: true,
        multiDevice: true,
      },
    },
  });
  console.log('✅ Plano anual: ', planAnnual.code, '— R$', (planAnnual.priceCents / 100).toFixed(2));

  // Alias: chave de teste antiga continua apontando pro plano legado
  const plan = planLegacy;

  // ---------- 2. Admin ----------
  const admin = await prisma.user.upsert({
    where: { email: process.env.ADMIN_EMAIL || 'melfi@improvavel.com.br' },
    update: {},
    create: {
      email: process.env.ADMIN_EMAIL || 'melfi@improvavel.com.br',
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme', 10),
      fullName: 'Melfi (Admin)',
      role: 'ADMIN',
    },
  });
  console.log('✅ Admin criado:', admin.email);

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
