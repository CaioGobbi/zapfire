// ============================================================
// ROTAS DE AUTH — endpoints que a extensão Chrome consome
// ============================================================

import { z } from 'zod';
import { validateKey } from '../services/keyService.js';

// Schema de validação da request — Zod bloqueia request malformada antes de chegar no service
const validateKeySchema = z.object({
  keyValue: z.string().length(32).regex(/^[a-f0-9]+$/, 'Chave deve ser 32 chars hex'),
  phone: z.string().min(10).max(20),
  deviceId: z.string().uuid(),
  chromeVersion: z.string().optional(),
});

export default async function authRoutes(fastify) {
  // --------------------------------------------------------
  // POST /auth/validate
  // --------------------------------------------------------
  // Endpoint principal — chamado pela extensão em 2 momentos:
  // 1. Quando o usuário cola a chave pela primeira vez (bind inicial)
  // 2. A cada abertura do WhatsApp Web (revalidação periódica, tipo a cada 30min)
  //
  // Rate limit agressivo: 30 req/min por IP. Pirataria tenta força bruta.
  // --------------------------------------------------------
  fastify.post(
    '/auth/validate',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      // 1. Valida o body
      const parsed = validateKeySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'BAD_REQUEST',
          message: 'Dados inválidos',
          errors: parsed.error.flatten(),
        });
      }

      // 2. Coleta contexto da request
      const ipAddress =
        request.headers['x-forwarded-for']?.split(',')[0].trim() ||
        request.ip;
      const userAgent = request.headers['user-agent'];

      // 3. Delega pra o service
      const result = await validateKey({
        ...parsed.data,
        ipAddress,
        userAgent,
      });

      // 4. Status HTTP coerente com o resultado
      if (!result.ok) {
        const statusMap = {
          INVALID_KEY: 401,
          WRONG_PHONE: 403,
          BLOCKED: 403,
          EXPIRED: 402,
          DEVICE_LIMIT: 429,
        };
        return reply.code(statusMap[result.code] || 400).send(result);
      }

      return reply.send(result);
    }
  );

  // --------------------------------------------------------
  // GET /auth/heartbeat
  // --------------------------------------------------------
  // Checagem leve — a extensão bate aqui periodicamente só pra
  // saber se a chave continua válida (sem precisar do número).
  // Usa header X-Zapfire-Key em vez de body pra ser GET.
  // --------------------------------------------------------
  fastify.get('/auth/heartbeat', async (request, reply) => {
    const keyValue = request.headers['x-zapfire-key'];
    if (!keyValue || keyValue.length !== 32) {
      return reply.code(401).send({ ok: false, code: 'INVALID_KEY' });
    }

    const { prisma } = await import('../lib/prisma.js');
    const key = await prisma.accessKey.findUnique({
      where: { keyValue },
      include: { subscription: true },
    });

    if (!key || key.status !== 'ACTIVE') {
      return reply.code(401).send({ ok: false, code: 'INVALID_KEY' });
    }

    const now = new Date();
    if (key.subscription.currentPeriodEnd < now) {
      return reply.code(402).send({ ok: false, code: 'EXPIRED' });
    }

    return reply.send({
      ok: true,
      expiresAt: key.subscription.currentPeriodEnd,
    });
  });
}
