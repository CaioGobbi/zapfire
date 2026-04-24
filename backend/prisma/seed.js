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

  // ---------- 1. Plano mensal ----------
  const plan = await prisma.plan.upsert({
    where: { code: 'monthly_x1' },
    update: {},
    create: {
      code: 'monthly_x1',
      name: 'Mensal X1',
      description: 'Plano mensal para afiliados X1',
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
  console.log('✅ Plano criado:', plan.code);

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
