// ============================================================
// ZAPFIRE — Config de URLs (build-replaced)
// ============================================================
// Arquivo COMMITADO com defaults de DESENVOLVIMENTO (localhost).
// Quando a gente roda `node build.mjs` na extensão, o script
// reescreve este arquivo no dist/ com os valores de produção
// lidos das env vars ZF_API_BASE e ZF_PANEL_URL.
//
// Ou seja:
//   - Chrome unpacked extension em dev: pega os defaults daqui
//   - Build pra CWS: sobrescrito com URLs reais (Railway + Vercel)
//
// Portanto: NUNCA use este arquivo com URLs de prod no git.
// ============================================================

export const API_BASE = 'http://localhost:3000/api/v1';
export const PANEL_URL = 'http://localhost:3001';
