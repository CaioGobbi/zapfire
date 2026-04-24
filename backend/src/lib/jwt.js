// ============================================================
// JWT — helpers de access token (15min) e refresh token (opaco)
// ============================================================
// Access token: JWT stateless, 15min, assinado com JWT_SECRET.
//   - aud: "zapfire-panel"  (só pro painel web usar)
//   - iss: "zapfire-api"    (origem do token)
//   - payload: { sub: userId, email, role }
//
// Refresh token: opaco (não é JWT), 32 bytes hex, 30 dias.
//   Guardado com hash SHA-256 no banco (tabela refresh_tokens)
//   pra permitir revogação e rotação.
//
// Segredo em JWT_SECRET (variável de ambiente). Se não estiver
// definido, todas as funções lançam — a gente quer falhar cedo,
// não gerar tokens com secret vazio.
// ============================================================

import jwt from 'jsonwebtoken';
import { generateSecureToken } from './tokens.js';

const ACCESS_EXPIRES = '15m';
const AUDIENCE = 'zapfire-panel';
const ISSUER = 'zapfire-api';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('JWT_SECRET não configurado (ou muito curto). Defina no .env com openssl rand -hex 32');
  }
  return s;
}

// ------------------------------------------------------------
// Access token — JWT curto, enviado no header Authorization
// ------------------------------------------------------------
export function signAccessToken(payload) {
  return jwt.sign(payload, getSecret(), {
    expiresIn: ACCESS_EXPIRES,
    audience: AUDIENCE,
    issuer: ISSUER,
  });
}

// Valida e retorna o payload. Lança em caso de inválido/expirado.
export function verifyAccessToken(token) {
  return jwt.verify(token, getSecret(), {
    audience: AUDIENCE,
    issuer: ISSUER,
  });
}

// ------------------------------------------------------------
// Refresh token plaintext — opaco, guardado com hash no banco
// ------------------------------------------------------------
// Retorna { plaintext, hash }. Caller precisa:
//   - Setar plaintext no cookie HttpOnly do cliente
//   - Salvar hash + userId + expiresAt em refresh_tokens
// ------------------------------------------------------------
export function signRefreshPlainToken() {
  return generateSecureToken();
}
