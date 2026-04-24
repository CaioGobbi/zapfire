// ============================================================
// ZAPFIRE BACKEND — entrypoint
// ============================================================

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhooks.js';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty' }
        : undefined,
  },
  trustProxy: true, // pra Render/Cloudflare pegarem o IP real
});

// --- Segurança básica ---
await fastify.register(helmet, { contentSecurityPolicy: false });

// --- CORS ---
// A extensão Chrome chama de uma origem tipo chrome-extension://<id>
// Então a gente libera tudo por enquanto e refina depois.
await fastify.register(cors, {
  origin: true,
  credentials: false,
});

// --- Rate limit global (por IP) ---
await fastify.register(rateLimit, {
  global: false, // ativo só nas rotas que declaram
  max: 100,
  timeWindow: '1 minute',
});

// --- Health check ---
fastify.get('/health', async () => ({
  ok: true,
  service: 'zapfire-backend',
  time: new Date().toISOString(),
}));

// --- Rotas ---
await fastify.register(authRoutes, { prefix: '/api/v1' });
await fastify.register(webhookRoutes, { prefix: '/api/v1' });

// --- Start ---
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

try {
  await fastify.listen({ port, host });
  fastify.log.info(`Zapfire backend rodando em http://${host}:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
