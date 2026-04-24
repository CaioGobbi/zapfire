// ============================================================
// AUTH GUARD — preHandler que exige Authorization Bearer <jwt>
// ============================================================
// Uso:
//   fastify.get('/me', { preHandler: authGuard }, handler)
//
// Lê o header "Authorization: Bearer <jwt>", valida com
// verifyAccessToken (aud=zapfire-panel, iss=zapfire-api, exp 15min),
// e popula request.user = { id, email, role }.
//
// Falhas:
//   - Sem header ou sem "Bearer "         → 401 UNAUTHORIZED
//   - Token malformado/inválido/expirado  → 401 UNAUTHORIZED (mensagem diferencia expirado)
// ============================================================

import { verifyAccessToken } from '../lib/jwt.js';

export async function authGuard(request, reply) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED', message: 'Token ausente' });
  }
  const token = header.slice(7).trim();
  if (!token) {
    return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED', message: 'Token vazio' });
  }

  try {
    const payload = verifyAccessToken(token);
    request.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  } catch (err) {
    const expired = err?.name === 'TokenExpiredError';
    return reply.code(401).send({
      ok: false,
      code: expired ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED',
      message: expired ? 'Token expirado — faça refresh' : 'Token inválido',
    });
  }
}
