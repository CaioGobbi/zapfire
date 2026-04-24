// ============================================================
// ACCOUNT ROUTES — endpoints consumidos pelo painel web
// ============================================================
// Prefixo (registrado em server.js): /api/v1/account
//
// Públicas:
//   POST /magic-link-request  — pede link por email (anti-enumeration)
//   POST /consume-magic-link  — consome token + seta senha, retorna sessão
//   POST /login               — email+senha, retorna sessão
//   POST /refresh             — usa cookie, rotaciona refresh, retorna novo access
//   POST /logout              — revoga refresh, limpa cookie
//
// Autenticadas (preHandler authGuard):
//   GET  /me                   — dados do usuário
//   GET  /subscription         — assinatura ativa + info de grace period
//   GET  /keys                 — lista chaves do usuário
//   GET  /keys/:id/devices     — dispositivos de uma chave (verifica ownership)
//   POST /keys/:id/reset-bind  — reset self-service (1x/mês)
//   GET  /payments             — histórico de pagamentos paginado
//   GET  /validations          — histórico de /auth/validate da(s) chave(s)
//
// Sessão:
//   - access token: JWT 15min no body da response, client guarda em memória
//   - refresh token: opaco 32B hex, salvo como hash no banco, em cookie HttpOnly
//     SameSite=Strict (Secure só em produção)
//   - rotação em cada /refresh: revoga o atual, cria novo
// ============================================================

import { z } from 'zod';
import bcrypt from 'bcrypt';

import { prisma } from '../lib/prisma.js';
import { signAccessToken, signRefreshPlainToken } from '../lib/jwt.js';
import { hashToken, generateSecureToken } from '../lib/tokens.js';
import { sendEmail } from '../lib/resend.js';
import { authGuard } from '../middleware/authGuard.js';

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------
const REFRESH_COOKIE = 'zf_refresh';
const REFRESH_TTL_MS = 30 * 86400_000;    // 30 dias
const MAGIC_LINK_TTL_MS = 7 * 86400_000;  // 7 dias
const PW_MIN = 8;

// Bcrypt fake hash pra tempo-constante em login quando user não existe
// (evita enumeration por timing attack). Qualquer hash bcrypt válido serve.
const BCRYPT_FAKE =
  '$2b$12$CwzJq1YJfYhLtHJZVXNwSOF1iwbYMPMi3R3nn7oi9pRuzgvvWCB2G';

// ------------------------------------------------------------
// Rate limit por email pro /login (além do IP-based via @fastify/rate-limit).
// Simples, em memória. Pra single-server é suficiente.
// ------------------------------------------------------------
const loginEmailAttempts = new Map();

function hitEmailRateLimit(email, maxPerHour = 10) {
  const now = Date.now();
  const cutoff = now - 3_600_000;
  const arr = (loginEmailAttempts.get(email) || []).filter((t) => t > cutoff);
  if (arr.length >= maxPerHour) {
    loginEmailAttempts.set(email, arr);
    return false;
  }
  arr.push(now);
  loginEmailAttempts.set(email, arr);
  return true;
}

// ------------------------------------------------------------
// Cookie options
// ------------------------------------------------------------
function refreshCookieOpts() {
  // SameSite=Lax: envia em navegações top-level + fetch same-site.
  // Nosso setup (:3001 ↔ :3000) é same-site (ambos localhost), então Lax
  // atende. Strict era bloqueado em alguns cenários de bootstrap por F5.
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/v1/account',
    maxAge: Math.floor(REFRESH_TTL_MS / 1000),
  };
}

function getIp(request) {
  return (
    request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    request.ip ||
    null
  );
}

function panelBaseUrl() {
  return (process.env.PANEL_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

// ------------------------------------------------------------
// Cria sessão: JWT access + refresh opaco (no banco + cookie)
// ------------------------------------------------------------
async function createSession(userId, request, reply) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('user_not_found_in_createSession');

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });

  const { plaintext, hash } = signRefreshPlainToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      userAgent: request.headers['user-agent']?.slice(0, 255) || null,
      ipAddress: getIp(request),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  reply.setCookie(REFRESH_COOKIE, plaintext, refreshCookieOpts());

  return {
    ok: true,
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      emailVerified: user.emailVerified,
    },
  };
}

// ============================================================
// Rotas
// ============================================================
export default async function accountRoutes(fastify) {
  // ====================================================
  // POST /magic-link-request  (público, rate 5/min/IP)
  // ====================================================
  fastify.post(
    '/magic-link-request',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = z.object({ email: z.string().email() }).safeParse(request.body);
      // Resposta padrão (anti-enumeration): sempre 200 com mesma mensagem
      const publicMsg = 'Se o email estiver cadastrado, enviaremos um link em instantes.';
      if (!parsed.success) {
        return reply.code(200).send({ ok: true, message: publicMsg });
      }
      const email = parsed.data.email.toLowerCase().trim();
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        const { plaintext, hash } = generateSecureToken();
        await prisma.emailToken.create({
          data: {
            userId: user.id,
            type: 'MAGIC_LINK',
            tokenHash: hash,
            expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
          },
        });
        const url = `${panelBaseUrl()}/primeiro-acesso?token=${plaintext}`;
        const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#0a0a0a;color:#f5f5f5;padding:32px;">
          <div style="max-width:520px;margin:0 auto;">
            <h1 style="color:#f5f5f5;">Seu link de acesso Zapfire</h1>
            <p style="color:#d4d4d4;font-size:15px;line-height:1.6;">Clique no link abaixo pra acessar sua conta. Expira em 7 dias.</p>
            <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#ff3b30;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Acessar minha conta</a></p>
            <p style="color:#a3a3a3;font-size:12px;word-break:break-all;">Ou copie: ${url}</p>
          </div>
        </body></html>`;
        await sendEmail({
          to: email,
          subject: 'Zapfire — seu link de acesso',
          html,
          text: `Acesse sua conta Zapfire: ${url}\n(link expira em 7 dias)`,
        });
      }
      return reply.code(200).send({ ok: true, message: publicMsg });
    }
  );

  // ====================================================
  // POST /consume-magic-link  (público)
  // ====================================================
  fastify.post('/consume-magic-link', async (request, reply) => {
    const parsed = z
      .object({
        token: z.string().length(64).regex(/^[a-f0-9]+$/, 'Token inválido'),
        newPassword: z.string().min(PW_MIN, `Senha precisa ter no mínimo ${PW_MIN} caracteres`),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'BAD_REQUEST',
        errors: parsed.error.flatten(),
      });
    }
    const { token, newPassword } = parsed.data;
    const hash = hashToken(token);
    const record = await prisma.emailToken.findUnique({ where: { tokenHash: hash } });
    if (
      !record ||
      record.usedAt ||
      record.expiresAt < new Date() ||
      record.type !== 'MAGIC_LINK'
    ) {
      return reply.code(401).send({
        ok: false,
        code: 'INVALID_TOKEN',
        message: 'Link inválido ou expirado. Peça um novo link.',
      });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await bcrypt.hash(newPassword, 12),
          emailVerified: true,
          passwordSetAt: new Date(),
          lastLoginAt: new Date(),
        },
      }),
      prisma.emailToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    await prisma.auditLog.create({
      data: {
        userId: record.userId,
        action: 'user.password_set',
        entityType: 'User',
        entityId: record.userId,
        ipAddress: getIp(request),
      },
    }).catch(() => {});

    const session = await createSession(record.userId, request, reply);
    return reply.code(200).send(session);
  });

  // ====================================================
  // POST /login  (público, rate 5/min/IP + 10/hora/email)
  // ====================================================
  fastify.post(
    '/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = z
        .object({
          email: z.string().email(),
          password: z.string().min(1),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, code: 'BAD_REQUEST' });
      }

      const email = parsed.data.email.toLowerCase().trim();

      if (!hitEmailRateLimit(email, 10)) {
        return reply.code(429).send({
          ok: false,
          code: 'RATE_LIMIT_EMAIL',
          message: 'Muitas tentativas com esse email. Aguarde 1 hora.',
        });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      const storedHash = user?.passwordHash || BCRYPT_FAKE;
      const valid = await bcrypt.compare(parsed.data.password, storedHash);

      if (!user || !valid) {
        return reply.code(401).send({
          ok: false,
          code: 'INVALID_CREDENTIALS',
          message: 'Email ou senha incorretos.',
        });
      }
      if (!user.passwordSetAt) {
        return reply.code(403).send({
          ok: false,
          code: 'PASSWORD_NOT_SET',
          message: 'Você ainda não configurou sua senha. Use o link enviado por email.',
        });
      }
      if (!user.isActive) {
        return reply.code(403).send({ ok: false, code: 'USER_INACTIVE' });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const session = await createSession(user.id, request, reply);
      return reply.code(200).send(session);
    }
  );

  // ====================================================
  // POST /refresh  (cookie-only, rotação)
  // ====================================================
  fastify.post('/refresh', async (request, reply) => {
    const plain = request.cookies?.[REFRESH_COOKIE];
    if (!plain) {
      return reply.code(401).send({ ok: false, code: 'NO_REFRESH' });
    }
    const hash = hashToken(plain);
    const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      reply.clearCookie(REFRESH_COOKIE, refreshCookieOpts());
      return reply.code(401).send({ ok: false, code: 'INVALID_REFRESH' });
    }

    // Rotação: revoga o atual e cria novo via createSession
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    const session = await createSession(record.userId, request, reply);
    return reply.code(200).send(session);
  });

  // ====================================================
  // POST /logout  (revoga refresh + limpa cookie)
  // ====================================================
  fastify.post('/logout', async (request, reply) => {
    const plain = request.cookies?.[REFRESH_COOKIE];
    if (plain) {
      const hash = hashToken(plain);
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(REFRESH_COOKIE, refreshCookieOpts());
    return reply.code(200).send({ ok: true });
  });

  // ====================================================
  // GET /me  (auth)
  // ====================================================
  fastify.get('/me', { preHandler: authGuard }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        emailVerified: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    if (!user) return reply.code(404).send({ ok: false, code: 'USER_NOT_FOUND' });
    return reply.code(200).send({ ok: true, user });
  });

  // ====================================================
  // GET /subscription  (auth)
  // ====================================================
  fastify.get('/subscription', { preHandler: authGuard }, async (request, reply) => {
    const sub = await prisma.subscription.findFirst({
      where: {
        userId: request.user.id,
        status: { in: ['ACTIVE', 'CANCELED', 'PAST_DUE'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    if (!sub) return reply.code(200).send({ ok: true, subscription: null });

    const now = new Date();
    const graceDays = 3;
    const periodEnd = sub.currentPeriodEnd;
    const graceEndTs = periodEnd.getTime() + graceDays * 86400_000;
    const inGrace = now > periodEnd && now.getTime() <= graceEndTs;
    const graceEnd = new Date(graceEndTs);

    return reply.code(200).send({
      ok: true,
      subscription: {
        id: sub.id,
        status: sub.status,
        planCode: sub.plan.code,
        planName: sub.plan.name,
        priceCents: sub.plan.priceCents,
        billingCycle: sub.plan.billingCycle,
        currentPeriodEnd: sub.currentPeriodEnd,
        canceledAt: sub.canceledAt,
        autoRenew: sub.autoRenew,
        gatewayProvider: sub.gatewayProvider,
        inGracePeriod: inGrace,
        gracePeriodEndsAt: inGrace ? graceEnd.toISOString() : null,
        daysLeftGrace: inGrace ? Math.ceil((graceEndTs - now.getTime()) / 86400_000) : null,
      },
    });
  });

  // ====================================================
  // GET /keys  (auth)
  // ====================================================
  fastify.get('/keys', { preHandler: authGuard }, async (request, reply) => {
    const keys = await prisma.accessKey.findMany({
      where: { userId: request.user.id },
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
      },
    });
    return reply.code(200).send({ ok: true, keys });
  });

  // ====================================================
  // GET /keys/:id/devices  (auth + ownership)
  // ====================================================
  fastify.get('/keys/:id/devices', { preHandler: authGuard }, async (request, reply) => {
    const key = await prisma.accessKey.findUnique({
      where: { id: request.params.id },
      select: { id: true, userId: true },
    });
    if (!key || key.userId !== request.user.id) {
      return reply.code(404).send({ ok: false, code: 'KEY_NOT_FOUND' });
    }
    const devices = await prisma.keyDevice.findMany({
      where: { accessKeyId: key.id },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        userAgent: true,
        ipAddress: true,
        chromeVersion: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    });
    return reply.code(200).send({ ok: true, devices });
  });

  // ====================================================
  // POST /keys/:id/reset-bind  (auth + ownership + regra 1x/mês)
  // ====================================================
  fastify.post('/keys/:id/reset-bind', { preHandler: authGuard }, async (request, reply) => {
    // Importa tardio pra evitar ciclo e pegar a versão ampliada do keyService
    const { resetBind } = await import('../services/keyService.js');
    const result = await resetBind({
      keyId: request.params.id,
      userId: request.user.id,
      ipAddress: getIp(request),
    });
    if (!result.ok) {
      const statusMap = {
        KEY_NOT_FOUND: 404,
        RESET_LIMIT: 429,
      };
      return reply.code(statusMap[result.code] || 400).send(result);
    }
    return reply.code(200).send(result);
  });

  // ====================================================
  // GET /payments  (auth, paginado por cursor)
  // ====================================================
  fastify.get('/payments', { preHandler: authGuard }, async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 20, 100);
    const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : null;
    const payments = await prisma.payment.findMany({
      where: { subscription: { userId: request.user.id } },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        gatewayProvider: true,
        paidAmountCents: true,
        status: true,
        paymentMethod: true,
        paidAt: true,
        createdAt: true,
        nfIssued: true,
      },
    });
    const hasMore = payments.length > limit;
    const results = hasMore ? payments.slice(0, limit) : payments;
    return reply.code(200).send({
      ok: true,
      payments: results,
      nextCursor: hasMore ? results[results.length - 1].id : null,
    });
  });

  // ====================================================
  // GET /validations  (auth — validation_logs das chaves do user)
  // ====================================================
  fastify.get('/validations', { preHandler: authGuard }, async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const logs = await prisma.validationLog.findMany({
      where: { accessKey: { userId: request.user.id } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        result: true,
        reason: true,
        phoneTry: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        accessKeyId: true,
      },
    });
    return reply.code(200).send({ ok: true, validations: logs });
  });
}
