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
}
