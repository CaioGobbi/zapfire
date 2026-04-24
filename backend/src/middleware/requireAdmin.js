// ============================================================
// REQUIRE ADMIN — preHandler pra rotas do backoffice
// ============================================================
// Usa junto com authGuard. Fastify aceita array de preHandlers:
//   { preHandler: [authGuard, requireAdmin] }
//
// authGuard popula request.user com { id, email, role }. requireAdmin
// checa role === 'ADMIN'. Além disso, re-verifica no banco (defesa
// em profundidade) caso o role tenha sido rebaixado depois do token
// ter sido emitido — 403 se o user não é mais admin ativo.
// ============================================================

import { prisma } from '../lib/prisma.js';

export async function requireAdmin(request, reply) {
  if (!request.user?.id) {
    // authGuard deveria ter rodado antes; segurança extra
    return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
  }

  // Checa role atual no banco (não confia só no JWT)
  const u = await prisma.user.findUnique({
    where: { id: request.user.id },
    select: { role: true, isActive: true },
  });
  if (!u || !u.isActive || u.role !== 'ADMIN') {
    return reply.code(403).send({
      ok: false,
      code: 'FORBIDDEN',
      message: 'Acesso restrito a administradores',
    });
  }
}
