// ============================================================
// RESEND — wrapper de envio de email
// ============================================================
// Se RESEND_API_KEY não estiver definida, entra em modo mock:
// apenas loga no console e responde { ok: true, mockMode: true }.
// Isso permite desenvolver/testar o fluxo de webhooks, magic link,
// etc, sem precisar configurar conta Resend ainda.
//
// Sender é configurado via RESEND_FROM_EMAIL (ex: "Zapfire <contato@zapfire.com.br>").
// ============================================================

import { Resend } from 'resend';

const API_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.RESEND_FROM_EMAIL || 'Zapfire <onboarding@resend.dev>';

// Cliente Resend só é instanciado se tiver API key
let client = null;
if (API_KEY) {
  client = new Resend(API_KEY);
}

export function isMockMode() {
  return !client;
}

// ------------------------------------------------------------
// sendEmail({ to, subject, html, text })
// Retorna { ok: true, id?, mockMode? } ou { ok: false, error }.
// Nunca lança — falha de email NÃO deve derrubar webhook/login.
// ------------------------------------------------------------
export async function sendEmail({ to, subject, html, text }) {
  if (isMockMode()) {
    console.log('════════════════════════════════════════════════════════');
    console.log('[resend:mock] Email NÃO enviado (RESEND_API_KEY vazio)');
    console.log('   to     :', to);
    console.log('   from   :', FROM);
    console.log('   subject:', subject);
    if (text) {
      console.log('   text   :', text.slice(0, 500));
    }
    if (html) {
      console.log('   html   :', html.slice(0, 500));
    }
    console.log('════════════════════════════════════════════════════════');
    return { ok: true, mockMode: true };
  }

  try {
    const payload = { from: FROM, to, subject };
    if (html) payload.html = html;
    if (text) payload.text = text;

    const { data, error } = await client.emails.send(payload);
    if (error) {
      console.error('[resend:error]', JSON.stringify(error));
      return { ok: false, error: error.message || 'resend_error' };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[resend:exception]', err);
    return { ok: false, error: err?.message || 'resend_exception' };
  }
}
