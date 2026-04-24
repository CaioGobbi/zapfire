// ============================================================
// TOKENS — geração segura de tokens opacos (magic link, refresh)
// ============================================================
// Nunca salvamos plaintext no banco. O fluxo é:
//   1. Gera plaintext (32 bytes hex, ~256 bits de entropia)
//   2. Calcula SHA-256 do plaintext
//   3. Guarda SÓ o hash no banco
//   4. Envia plaintext pro cliente (email, cookie)
//   5. Quando cliente volta com plaintext, hasheia e bate com o banco
//
// Se o banco vazar, ninguém consegue reusar os tokens.
// ============================================================

import crypto from 'node:crypto';

// ------------------------------------------------------------
// Gera um par { plaintext, hash } pra guardar no banco.
// Plaintext: 64 chars hex (32 bytes aleatórios).
// Hash:      64 chars hex (SHA-256 do plaintext).
// ------------------------------------------------------------
export function generateSecureToken() {
  const plaintext = crypto.randomBytes(32).toString('hex');
  const hash = hashToken(plaintext);
  return { plaintext, hash };
}

// ------------------------------------------------------------
// Hashea um plaintext (pro lookup quando cliente volta com o token).
// ------------------------------------------------------------
export function hashToken(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}
