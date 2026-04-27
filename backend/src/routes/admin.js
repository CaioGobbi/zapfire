// ============================================================
// ADMIN ROUTES — backoffice (prefixo /api/v1/admin)
// ============================================================
// Todas as rotas aqui exigem JWT + role=ADMIN via [authGuard, requireAdmin].
// Ações destrutivas/mutativas registram audit_logs com `userId` do admin
// que executou (pra rastrear "quem fez o quê").
//
// Organização por seção:
//   - STATS: GET /stats
//   - USERS: GET /users, GET /users/:id, POST /users/:id/promote
//   - KEYS:  GET /keys, POST /keys/:id/reset-bind, /unlock-reset,
//            /block, /unblock
//   - SUBS:  POST /subscriptions/:id/extend, /set-status
// ============================================================

import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { authGuard } from '../middleware/authGuard.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { resetKeyBind } from '../services/keyService.js';
import {
  grantAccess,
  setUserPassword,
  grantNewKey,
  sendNewMagicLink,
} from '../services/grantService.js';

const ADMIN_GUARDS = { preHandler: [authGuard, requireAdmin] };

function getIp(request) {
  return (
    request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    request.ip ||
    null
  );
}

// ============================================================
export default async function adminRoutes(fastify) {
  // ====================================================
  // GET /stats — dashboard
  // ====================================================
  fastify.get('/stats', ADMIN_GUARDS, async (request, reply) => {
    const now = new Date();
    const graceWindowStart = new Date(now.getTime() - 3 * 86400_000); // 3d atrás

    const [
      totalUsers,
      activeUsers,
      totalKeys,
      activeKeys,
      blockedKeys,
      activeSubs,
      canceledSubs,
      expiredSubs,
      inGraceSubs,
      last7dSignups,
      last30dPayments,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.accessKey.count(),
      prisma.accessKey.count({ where: { status: 'ACTIVE' } }),
      prisma.accessKey.count({ where: { status: 'BLOCKED' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'CANCELED' } }),
      prisma.subscription.count({ where: { status: 'EXPIRED' } }),
      // Em grace = ACTIVE com currentPeriodEnd entre (now - 3d) e now
      prisma.subscription.count({
        where: {
          status: 'ACTIVE',
          currentPeriodEnd: { gte: graceWindowStart, lt: now },
        },
      }),
      prisma.user.count({
        where: { createdAt: { gte: new Date(now.getTime() - 7 * 86400_000) } },
      }),
      prisma.payment.aggregate({
        where: {
          status: 'PAID',
          paidAt: { gte: new Date(now.getTime() - 30 * 86400_000) },
        },
        _sum: { paidAmountCents: true },
        _count: true,
      }),
    ]);

    // MRR aproximado: soma de ACTIVE MONTHLY + (ACTIVE ANNUAL / 12)
    const [monthlyActive, annualActive] = await Promise.all([
      prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        include: { plan: true },
      }),
      Promise.resolve([]), // placeholder — agregado já no monthlyActive
    ]);
    let mrrCents = 0;
    for (const s of monthlyActive) {
      if (s.plan.billingCycle === 'MONTHLY') mrrCents += s.plan.priceCents;
      else if (s.plan.billingCycle === 'ANNUAL') mrrCents += Math.round(s.plan.priceCents / 12);
    }

    return reply.code(200).send({
      ok: true,
      stats: {
        users: { total: totalUsers, active: activeUsers },
        keys: { total: totalKeys, active: activeKeys, blocked: blockedKeys },
        subscriptions: {
          active: activeSubs,
          canceled: canceledSubs,
          expired: expiredSubs,
          inGrace: inGraceSubs,
        },
        last7dSignups,
        last30d: {
          paymentCount: last30dPayments._count || 0,
          revenueCents: last30dPayments._sum?.paidAmountCents || 0,
        },
        mrrCents,
      },
    });
  });

  // ====================================================
  // GET /users — lista paginada com search
  // ====================================================
  fastify.get('/users', ADMIN_GUARDS, async (request, reply) => {
    const q = z
      .object({
        search: z.string().optional(),
        role: z.enum(['CUSTOMER', 'AFFILIATE', 'ADMIN']).optional(),
        isActive: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
      .safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({ ok: false, code: 'BAD_QUERY', errors: q.error.flatten() });
    }
    const { search, role, isActive, limit, cursor } = q.data;

    const where = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const items = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        emailVerified: true,
        createdAt: true,
        lastLoginAt: true,
        _count: { select: { keys: true, subscriptions: true } },
      },
    });
    const hasMore = items.length > limit;
    const users = hasMore ? items.slice(0, limit) : items;
    return reply.code(200).send({
      ok: true,
      users,
      nextCursor: hasMore ? users[users.length - 1].id : null,
    });
  });

  // ====================================================
  // GET /users/:id — detalhe completo
  // ====================================================
  fastify.get('/users/:id', ADMIN_GUARDS, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        cpfCnpj: true,
        role: true,
        isActive: true,
        emailVerified: true,
        passwordSetAt: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    if (!user) return reply.code(404).send({ ok: false, code: 'USER_NOT_FOUND' });

    const [keys, subscriptions, recentPayments, recentValidations, recentAudit] = await Promise.all([
      prisma.accessKey.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          keyValue: true,
          label: true,
          boundPhone: true,
          boundAt: true,
          status: true,
          blockedReason: true,
          blockedAt: true,
          lastUsedAt: true,
          resetCount30d: true,
          resetCount30dResetAt: true,
          lastResetAt: true,
          createdAt: true,
          _count: { select: { devices: true, validations: true } },
        },
      }),
      prisma.subscription.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: { code: true, name: true, priceCents: true, billingCycle: true } } },
      }),
      prisma.payment.findMany({
        where: { subscription: { userId: user.id } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.validationLog.findMany({
        where: { accessKey: { userId: user.id } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.auditLog.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    // Pra cada key, lista os devices
    const keysWithDevices = await Promise.all(
      keys.map(async (k) => {
        const devices = await prisma.keyDevice.findMany({
          where: { accessKeyId: k.id },
          orderBy: { lastSeenAt: 'desc' },
        });
        return { ...k, devices };
      })
    );

    return reply.code(200).send({
      ok: true,
      user,
      keys: keysWithDevices,
      subscriptions,
      recentPayments,
      recentValidations,
      recentAudit,
    });
  });

  // ====================================================
  // GET /keys — lista rápida com search por keyValue prefix
  // ====================================================
  fastify.get('/keys', ADMIN_GUARDS, async (request, reply) => {
    const q = z
      .object({
        search: z.string().optional(), // busca por keyValue OU email do user
        status: z.enum(['ACTIVE', 'SUSPENDED', 'BLOCKED', 'EXPIRED']).optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
      .safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({ ok: false, code: 'BAD_QUERY' });
    }
    const { search, status, limit, cursor } = q.data;
    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { keyValue: { startsWith: search.toLowerCase() } },
        { label: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const items = await prisma.accessKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        keyValue: true,
        label: true,
        boundPhone: true,
        status: true,
        blockedReason: true,
        lastUsedAt: true,
        createdAt: true,
        user: { select: { id: true, email: true, fullName: true } },
        subscription: {
          select: {
            status: true,
            currentPeriodEnd: true,
            plan: { select: { code: true, name: true } },
          },
        },
      },
    });
    const hasMore = items.length > limit;
    const keys = hasMore ? items.slice(0, limit) : items;
    return reply.code(200).send({
      ok: true,
      keys,
      nextCursor: hasMore ? keys[keys.length - 1].id : null,
    });
  });

  // ====================================================
  // POST /keys/:id/reset-bind — força reset (bypass 1×/mês do self-service)
  // ====================================================
  fastify.post('/keys/:id/reset-bind', ADMIN_GUARDS, async (request, reply) => {
    try {
      const result = await resetKeyBind({
        keyId: request.params.id,
        adminUserId: request.user.id,
        ipAddress: getIp(request),
      });
      return reply.code(200).send(result);
    } catch (err) {
      return reply.code(404).send({ ok: false, code: 'KEY_NOT_FOUND', message: err.message });
    }
  });

  // ====================================================
  // POST /keys/:id/unlock-reset — zera resetCount30d pra liberar 1 reset pro user
  // ====================================================
  fastify.post('/keys/:id/unlock-reset', ADMIN_GUARDS, async (request, reply) => {
    const key = await prisma.accessKey.findUnique({ where: { id: request.params.id } });
    if (!key) return reply.code(404).send({ ok: false, code: 'KEY_NOT_FOUND' });

    await prisma.accessKey.update({
      where: { id: key.id },
      data: { resetCount30d: 0, resetCount30dResetAt: null },
    });
    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.key.reset_unlocked',
        entityType: 'AccessKey',
        entityId: key.id,
        metadata: { forUserId: key.userId, previousCount: key.resetCount30d },
        ipAddress: getIp(request),
      },
    });
    return reply.code(200).send({ ok: true, message: 'Reset liberado — user pode resetar novamente este mês' });
  });

  // ====================================================
  // POST /keys/:id/block
  // ====================================================
  fastify.post('/keys/:id/block', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z.object({ reason: z.string().max(500).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'BAD_REQUEST' });

    const key = await prisma.accessKey.findUnique({ where: { id: request.params.id } });
    if (!key) return reply.code(404).send({ ok: false, code: 'KEY_NOT_FOUND' });

    const reason = parsed.data.reason || 'Bloqueio manual pelo admin';
    await prisma.accessKey.update({
      where: { id: key.id },
      data: {
        status: 'BLOCKED',
        blockedReason: reason,
        blockedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.key.blocked',
        entityType: 'AccessKey',
        entityId: key.id,
        metadata: { forUserId: key.userId, reason, previousStatus: key.status },
        ipAddress: getIp(request),
      },
    });
    return reply.code(200).send({ ok: true, message: 'Chave bloqueada' });
  });

  // ====================================================
  // POST /keys/:id/unblock
  // ====================================================
  fastify.post('/keys/:id/unblock', ADMIN_GUARDS, async (request, reply) => {
    const key = await prisma.accessKey.findUnique({ where: { id: request.params.id } });
    if (!key) return reply.code(404).send({ ok: false, code: 'KEY_NOT_FOUND' });

    await prisma.accessKey.update({
      where: { id: key.id },
      data: {
        status: 'ACTIVE',
        blockedReason: null,
        blockedAt: null,
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.key.unblocked',
        entityType: 'AccessKey',
        entityId: key.id,
        metadata: { forUserId: key.userId, previousStatus: key.status, previousReason: key.blockedReason },
        ipAddress: getIp(request),
      },
    });
    return reply.code(200).send({ ok: true, message: 'Chave desbloqueada' });
  });

  // ====================================================
  // POST /subscriptions/:id/extend — adiciona N dias ao currentPeriodEnd
  // ====================================================
  fastify.post('/subscriptions/:id/extend', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z
      .object({ days: z.number().int().min(1).max(3650) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'BAD_REQUEST' });

    const sub = await prisma.subscription.findUnique({ where: { id: request.params.id } });
    if (!sub) return reply.code(404).send({ ok: false, code: 'SUBSCRIPTION_NOT_FOUND' });

    const days = parsed.data.days;
    const newEnd = new Date(sub.currentPeriodEnd.getTime() + days * 86400_000);

    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        currentPeriodEnd: newEnd,
        // Se estava EXPIRED, reativa
        status: sub.status === 'EXPIRED' ? 'ACTIVE' : sub.status,
        gracePeriodEndsAt: null,
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.subscription.extended',
        entityType: 'Subscription',
        entityId: sub.id,
        metadata: {
          forUserId: sub.userId,
          days,
          previousEnd: sub.currentPeriodEnd.toISOString(),
          newEnd: newEnd.toISOString(),
        },
        ipAddress: getIp(request),
      },
    });
    return reply.code(200).send({
      ok: true,
      message: `Assinatura estendida em ${days} dias`,
      currentPeriodEnd: newEnd,
    });
  });

  // ====================================================
  // POST /subscriptions/:id/change-plan — troca planId
  // ====================================================
  // Útil pra promover Free → Pro pra teste interno ou cortesia,
  // ou rebaixar caso de chargeback. Não mexe em datas (só no plano)
  // — pra renovar prazo, usar /extend separadamente.
  fastify.post('/subscriptions/:id/change-plan', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z
      .object({ planCode: z.string().min(1).max(40) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'BAD_REQUEST' });

    const sub = await prisma.subscription.findUnique({
      where: { id: request.params.id },
      include: { plan: true },
    });
    if (!sub) return reply.code(404).send({ ok: false, code: 'SUBSCRIPTION_NOT_FOUND' });

    const newPlan = await prisma.plan.findUnique({ where: { code: parsed.data.planCode } });
    if (!newPlan) return reply.code(404).send({ ok: false, code: 'PLAN_NOT_FOUND' });

    // No-op se já está no plano alvo
    if (newPlan.id === sub.planId) {
      return reply.code(200).send({
        ok: true,
        message: 'Assinatura já está nesse plano',
        unchanged: true,
      });
    }

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { planId: newPlan.id },
    });
    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.subscription.plan_changed',
        entityType: 'Subscription',
        entityId: sub.id,
        metadata: {
          forUserId: sub.userId,
          previousPlanCode: sub.plan?.code,
          previousPlanName: sub.plan?.name,
          newPlanCode: newPlan.code,
          newPlanName: newPlan.name,
          // Snapshot de features pra auditar mudanças de gate (Sprint 5)
          previousFeatures: sub.plan?.features,
          newFeatures: newPlan.features,
        },
        ipAddress: getIp(request),
      },
    });
    return reply.code(200).send({
      ok: true,
      message: `Plano alterado de "${sub.plan?.name}" pra "${newPlan.name}"`,
      newPlanCode: newPlan.code,
      newPlanName: newPlan.name,
    });
  });

  // ====================================================
  // POST /subscriptions/:id/set-status — muda status manualmente
  // ====================================================
  fastify.post('/subscriptions/:id/set-status', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z
      .object({
        status: z.enum(['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'BLOCKED']),
        reason: z.string().max(500).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'BAD_REQUEST' });

    const sub = await prisma.subscription.findUnique({ where: { id: request.params.id } });
    if (!sub) return reply.code(404).send({ ok: false, code: 'SUBSCRIPTION_NOT_FOUND' });

    const data = { status: parsed.data.status };
    if (parsed.data.status === 'CANCELED') {
      data.canceledAt = new Date();
      if (parsed.data.reason) data.cancelReason = parsed.data.reason;
    }
    await prisma.subscription.update({ where: { id: sub.id }, data });
    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.subscription.status_changed',
        entityType: 'Subscription',
        entityId: sub.id,
        metadata: {
          forUserId: sub.userId,
          previousStatus: sub.status,
          newStatus: parsed.data.status,
          reason: parsed.data.reason || null,
        },
        ipAddress: getIp(request),
      },
    });
    return reply.code(200).send({ ok: true, message: 'Status atualizado' });
  });

  // ====================================================
  // GET /emails — lista email tokens com status de entrega (Sprint 6)
  // ====================================================
  fastify.get('/emails', ADMIN_GUARDS, async (request, reply) => {
    const q = z
      .object({
        status: z.enum(['sent', 'delivered', 'bounced', 'complained', 'failed', 'pending']).optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
      })
      .safeParse(request.query);
    if (!q.success) return reply.code(400).send({ ok: false, code: 'BAD_QUERY' });

    const where = {};
    if (q.data.status === 'pending') {
      where.deliveryStatus = null;
    } else if (q.data.status) {
      where.deliveryStatus = q.data.status;
    }

    const tokens = await prisma.emailToken.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.data.limit,
      select: {
        id: true,
        type: true,
        deliveryStatus: true,
        deliveryUpdatedAt: true,
        resendEmailId: true,
        usedAt: true,
        expiresAt: true,
        createdAt: true,
        user: { select: { id: true, email: true, fullName: true } },
      },
    });
    return reply.code(200).send({ ok: true, emails: tokens });
  });

  // ====================================================
  // GET /kirvano-mapping — visibilidade do offer_id → plano (read-only)
  // ====================================================
  fastify.get('/kirvano-mapping', ADMIN_GUARDS, async (request, reply) => {
    const { getOfferMappings } = await import('../lib/kirvanoParser.js');
    const mapping = getOfferMappings();
    const plans = await prisma.plan.findMany({
      where: { code: { in: ['monthly_v1', 'annual_v1'] } },
      select: { code: true, name: true, priceCents: true, billingCycle: true },
    });
    return reply.code(200).send({
      ok: true,
      mapping,
      plans,
      note: 'Offer IDs são hardcoded em backend/src/lib/kirvanoParser.js. Pra adicionar, edite o arquivo e faça redeploy.',
    });
  });

  // ====================================================
  // POST /users/:id/promote — muda role do user
  // ====================================================
  fastify.post('/users/:id/promote', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z
      .object({ role: z.enum(['CUSTOMER', 'AFFILIATE', 'ADMIN']) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'BAD_REQUEST' });

    const target = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!target) return reply.code(404).send({ ok: false, code: 'USER_NOT_FOUND' });

    // Impede rebaixar o próprio admin logado (evita travar conta)
    if (target.id === request.user.id && parsed.data.role !== 'ADMIN') {
      return reply.code(400).send({
        ok: false,
        code: 'CANNOT_DEMOTE_SELF',
        message: 'Você não pode rebaixar a própria conta admin. Peça pra outro admin.',
      });
    }

    await prisma.user.update({
      where: { id: target.id },
      data: { role: parsed.data.role },
    });
    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.user.promoted',
        entityType: 'User',
        entityId: target.id,
        metadata: {
          email: target.email,
          previousRole: target.role,
          newRole: parsed.data.role,
        },
        ipAddress: getIp(request),
      },
    });
    return reply.code(200).send({ ok: true, message: `Role alterada pra ${parsed.data.role}` });
  });

  // ====================================================
  // POST /grant-access — cria/anexa cortesia completa
  // ====================================================
  // Equivalente UI do scripts/grant-access.js. Cria User (ou reusa
  // se já existe), Subscription manual, AccessKey nova (ou reusa
  // se user já tem ativa), opcional magic link, opcional email.
  // ====================================================
  fastify.post('/grant-access', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z
      .object({
        email: z.string().email(),
        dias: z.number().int().min(1).max(3650).default(365),
        planCode: z.enum(['monthly_v1', 'annual_v1', 'monthly_x1']).default('monthly_v1'),
        nome: z.string().trim().min(1).max(120).optional(),
        label: z.string().trim().min(1).max(120).optional(),
        senha: z.string().min(8).max(128).optional(),
        sendEmail: z.boolean().default(true),
        forceNewKey: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, code: 'BAD_REQUEST', issues: parsed.error.issues });
    }

    const result = await grantAccess(parsed.data);
    if (!result.ok) {
      const status = result.code === 'PLAN_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send(result);
    }

    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.access.granted',
        entityType: 'Subscription',
        entityId: result.subscription.id,
        metadata: {
          targetEmail: parsed.data.email,
          targetUserId: result.user.id,
          planCode: parsed.data.planCode,
          dias: parsed.data.dias,
          userIsNew: result.userIsNew,
          keyReused: result.keyReused,
          hadSenha: !!parsed.data.senha,
          sentEmail: parsed.data.sendEmail,
          source: 'admin_panel',
        },
        ipAddress: getIp(request),
      },
    });

    return reply.code(200).send({
      ok: true,
      userId: result.user.id,
      subscriptionId: result.subscription.id,
      keyValue: result.accessKey.keyValue,
      keyReused: result.keyReused,
      userIsNew: result.userIsNew,
      magicLinkUrl: result.magicLinkUrl,
      emailSent: result.emailResult?.ok || false,
      emailMockMode: result.emailResult?.mockMode || false,
    });
  });

  // ====================================================
  // POST /users/:id/set-password — admin define senha do user
  // ====================================================
  fastify.post('/users/:id/set-password', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z
      .object({ senha: z.string().min(8).max(128) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, code: 'BAD_REQUEST', issues: parsed.error.issues });
    }

    const result = await setUserPassword({
      userId: request.params.id,
      senha: parsed.data.senha,
    });
    if (!result.ok) {
      const status = result.code === 'USER_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send(result);
    }

    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.user.password_set',
        entityType: 'User',
        entityId: result.user.id,
        metadata: {
          targetEmail: result.user.email,
          revokedRefreshTokens: true,
        },
        ipAddress: getIp(request),
      },
    });

    return reply.code(200).send({
      ok: true,
      message: 'Senha definida e sessões anteriores invalidadas',
    });
  });

  // ====================================================
  // POST /users/:id/grant-key — nova subscription + nova chave
  // ====================================================
  // Sempre cria chave NOVA (não reusa). Pressupõe user existe.
  // Útil quando: cliente quer chave separada pra outro número, ou
  // assinatura adicional (ex: comprou um anual extra de presente).
  // ====================================================
  fastify.post('/users/:id/grant-key', ADMIN_GUARDS, async (request, reply) => {
    const parsed = z
      .object({
        dias: z.number().int().min(1).max(3650).default(365),
        planCode: z.enum(['monthly_v1', 'annual_v1', 'monthly_x1']).default('monthly_v1'),
        label: z.string().trim().min(1).max(120).optional(),
        sendEmail: z.boolean().default(true),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, code: 'BAD_REQUEST', issues: parsed.error.issues });
    }

    const result = await grantNewKey({
      userId: request.params.id,
      ...parsed.data,
    });
    if (!result.ok) {
      const status = result.code === 'USER_NOT_FOUND' || result.code === 'PLAN_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send(result);
    }

    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.key.granted',
        entityType: 'AccessKey',
        entityId: result.accessKey.id,
        metadata: {
          targetUserId: result.user.id,
          targetEmail: result.user.email,
          subscriptionId: result.subscription.id,
          planCode: parsed.data.planCode,
          dias: parsed.data.dias,
          sentEmail: parsed.data.sendEmail,
        },
        ipAddress: getIp(request),
      },
    });

    return reply.code(200).send({
      ok: true,
      keyValue: result.accessKey.keyValue,
      subscriptionId: result.subscription.id,
      emailSent: result.emailResult?.ok || false,
      emailMockMode: result.emailResult?.mockMode || false,
    });
  });

  // ====================================================
  // POST /users/:id/send-magic-link — gera + envia novo magic link
  // ====================================================
  // Não invalida tokens anteriores (cliente pode ter outros válidos).
  // Useful quando: cliente perdeu o email, link expirou, quer
  // redefinir senha pelo fluxo padrão.
  // ====================================================
  fastify.post('/users/:id/send-magic-link', ADMIN_GUARDS, async (request, reply) => {
    const result = await sendNewMagicLink({ userId: request.params.id });
    if (!result.ok) {
      const status = result.code === 'USER_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send(result);
    }

    await prisma.auditLog.create({
      data: {
        userId: request.user.id,
        action: 'admin.magic_link.sent',
        entityType: 'User',
        entityId: result.user.id,
        metadata: {
          targetEmail: result.user.email,
          emailSent: result.emailResult?.ok || false,
        },
        ipAddress: getIp(request),
      },
    });

    return reply.code(200).send({
      ok: true,
      magicLinkUrl: result.magicLinkUrl,
      emailSent: result.emailResult?.ok || false,
      emailMockMode: result.emailResult?.mockMode || false,
    });
  });
}
