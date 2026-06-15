// ============================================================
// ZAPFIRE — Audio Config (constantes canonicais PTT)
// ============================================================
// Spec do WhatsApp PTT (push-to-talk):
//   - Container: OGG
//   - Codec:     Opus (VOIP profile)
//   - Sample rate: 16000 Hz (WA Web nativo grava em 16kHz)
//   - Channels:  mono (1)
//   - Bitrate:   24-32 kbps (sweet spot pra voz humana)
//   - Mimetype canonical: 'audio/ogg; codecs=opus' (com espaço, padrão Baileys/WPP)
//
// Esse arquivo existe pra impedir o landmine que tava no codebase:
// manager.js encodava 'audio/ogg;codecs=opus' (sem espaço), o resto
// do código comparava com 'audio/ogg; codecs=opus' (com espaço).
// Comparações estritas (===) falhavam silenciosamente. Agora todos
// importam daqui.
// ============================================================

// Mimetype canonical do PTT — sempre com espaço após o ;
export const PTT_MIME = 'audio/ogg; codecs=opus';

// Encoder params (usados em convertToOggOpus + reconvertLegacyAudios)
export const PTT_SAMPLE_RATE = 16000;
export const PTT_CHANNELS = 1;
export const PTT_BITRATE = 24000;

// Magic bytes do container OGG: "OggS" em ASCII (0x4F 0x67 0x67 0x53).
// Usado pra sniff binário de arquivos: o mimetype declarado pode
// mentir, mas os primeiros 4 bytes do container não.
export const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53];

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

// Aceita 'audio/ogg', 'audio/ogg;codecs=opus', 'audio/ogg; codecs=opus',
// 'audio/ogg+opus' (errado mas existe), com ou sem espaços/case variations.
// Retorna true se o type DECLARADO sugere OGG com Opus.
export function isOggOpusMime(type) {
  if (!type || typeof type !== 'string') return false;
  const t = type.toLowerCase();
  return t.includes('ogg') && t.includes('opus');
}

// Sniff binário: confirma que o blob começa com magic 'OggS'.
// Mais confiável que mimetype declarado — mimetype pode ser
// mentira (catch silencioso pre-0.4.5 salvava MP3 como audio/ogg).
export async function isOggBlobReal(blob) {
  if (!(blob instanceof Blob) || blob.size < 4) return false;
  try {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return head[0] === OGG_MAGIC[0]
      && head[1] === OGG_MAGIC[1]
      && head[2] === OGG_MAGIC[2]
      && head[3] === OGG_MAGIC[3];
  } catch (_) {
    return false;
  }
}

// Decide se um item de áudio precisa ser reconvertido pelo batch
// (botão "Atualizar biblioteca"). Critério:
//   1. Sem flag pttCompat = áudio salvo antes da 0.4.5 (sample rate
//      pode ser 48kHz stereo, mimetype pode ser mentira do catch
//      silencioso)
//   2. Mimetype declarado não é OGG Opus
// Não checa bytes aqui — é cheap classifier pra UI mostrar contagem.
// O batch faz validação binária real.
export function needsReconvert(item) {
  if (!item || item.type !== 'audio') return false;
  if (item.pttCompat === 1) return false;
  return true;
}
