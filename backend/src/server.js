// ============================================================
// ZAPFIRE BACKEND — entrypoint
// ============================================================

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';

import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhooks.js';
import accountRoutes from './routes/account.js';

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
// - Extensão Chrome: origin chrome-extension://<id>. Sempre aceita (echo do próprio origin)
// - Painel web: origin(s) em PANEL_ORIGINS (default: localhost:3001). Aceita com credentials
//   (necessário pro cookie de refresh)
// - Requests sem origin (curl, server-to-server): aceita
await fastify.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.startsWith('chrome-extension://')) return cb(null, origin);
    const allowed = (process.env.PANEL_ORIGINS || process.env.PANEL_BASE_URL || 'http://localhost:3001')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.includes(origin)) return cb(null, origin);
    return cb(null, false);
  },
  credentials: true,
});

// --- Cookies (pro refresh token HttpOnly do painel) ---
await fastify.register(cookie);

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
await fastify.register(accountRoutes, { prefix: '/api/v1/account' });

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
