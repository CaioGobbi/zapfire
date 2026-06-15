// ============================================================
// ZAPFIRE — Audio Reconvert (batch migration 0.4.5)
// ============================================================
// Reconverte áudios "legacy" (sem flag pttCompat=1) pra encoder
// canonical 16kHz mono Opus. Resolve áudios:
//   - Importados de backups ZapVoice (mimetype 'audio/ogg' puro,
//     encoding 48kHz stereo — Android tolera, iPhone rejeita)
//   - Salvos antes da 0.4.5 com sample rate device-default (44.1k/48k)
//   - Que tiveram catch silencioso engolido (MP3/WAV salvo como
//     audio mas com bytes não-OGG)
//
// Sem reupload de backup pelo usuário. Tudo automático.
//
// API:
//   reconvertLegacyAudios({ converter, onProgress, signal })
//     converter: (blob) => Promise<Blob>  // o convertToOggOpus
//                                            do manager (que tem
//                                            OpusMediaRecorder carregado)
//     onProgress: ({ done, total, current, status }) => void
//     signal: AbortSignal (opcional pra cancelar)
//   Retorna: { ok, converted, skipped, failed, errors }
// ============================================================

import { listItems, putItem, setMeta, getMeta } from './storage.js';
import { needsReconvert, PTT_MIME } from './audio-config.js';

const META_KEY = 'reconvert.state';

// Lista os items áudio que precisam ser reconvertidos
export async function listLegacyAudios() {
  const items = await listItems();
  return items.filter(needsReconvert);
}

// Quantidade rápida pra UI (sem carregar blobs grandes)
export async function countLegacyAudios() {
  const list = await listLegacyAudios();
  return list.length;
}

// Estado persistido entre sessões pra retomar de onde parou se
// o user fechou a aba mid-batch
async function readState() {
  const s = await getMeta(META_KEY, null);
  return s || { completedIds: [], lastRunAt: null };
}

async function writeState(state) {
  await setMeta(META_KEY, state);
}

// Conversor batch principal. Processa item a item, salva incremental
// pra que progresso não se perca em crash. Não bloqueia: cada item
// é uma Promise sequencial dentro de loop async.
//
// Retorna depois que termina (ou aborta). onProgress é chamado a cada
// item começando, terminando, ou falhando.
export async function reconvertLegacyAudios({ converter, onProgress, signal } = {}) {
  if (typeof converter !== 'function') {
    throw new Error('converter function obrigatório');
  }
  const emit = (info) => {
    try { if (onProgress) onProgress(info); } catch (_) {}
  };

  const items = await listLegacyAudios();
  const state = await readState();
  const completedSet = new Set(state.completedIds || []);
  // Filtra os que já foram processados em runs anteriores
  const pending = items.filter((it) => !completedSet.has(it.id));

  const total = items.length;
  let done = total - pending.length;
  let converted = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  emit({ done, total, current: null, status: 'starting' });

  for (const item of pending) {
    if (signal && signal.aborted) {
      emit({ done, total, current: null, status: 'aborted' });
      return { ok: false, aborted: true, converted, skipped, failed, errors };
    }

    emit({ done, total, current: item.title || 'sem nome', status: 'converting' });

    try {
      if (!(item.content instanceof Blob)) {
        // Sem blob — corrompido ou item órfão. Marca como skipped
        // e adiciona o id ao completedIds pra não tentar de novo.
        skipped++;
        completedSet.add(item.id);
        done++;
        continue;
      }

      const newBlob = await converter(item.content);

      if (!(newBlob instanceof Blob) || newBlob.size === 0) {
        throw new Error('converter retornou blob inválido');
      }

      // Salva de volta com flag pttCompat=1
      const updated = {
        ...item,
        content: newBlob,
        mimeType: PTT_MIME,
        size: newBlob.size,
        pttCompat: 1,
      };
      await putItem(updated);

      converted++;
      completedSet.add(item.id);
    } catch (e) {
      failed++;
      const msg = (e && e.message) || String(e);
      errors.push({ id: item.id, title: item.title, message: msg });
      // NÃO adiciona em completedIds — vai tentar de novo na próxima
      // batch. Mas marca o item com flag pttBroken pra UI exibir
      // estado claro pro usuário.
      try {
        await putItem({ ...item, pttBroken: true, pttBrokenReason: msg });
      } catch (_) {}
    }

    done++;
    // Salva estado incremental a cada item processado — se browser
    // crashar/fechar, próxima abertura continua de onde parou.
    try {
      await writeState({
        completedIds: Array.from(completedSet),
        lastRunAt: Date.now(),
      });
    } catch (_) {}

    emit({ done, total, current: item.title || 'sem nome', status: 'item-done' });

    // Yield pro event loop pra UI não congelar
    await new Promise((r) => setTimeout(r, 50));
  }

  emit({ done, total, current: null, status: 'finished' });

  return { ok: true, converted, skipped, failed, errors };
}

// Reseta o tracker — útil quando user quer forçar rerun completo
// (ex: nova spec do encoder no futuro)
export async function resetReconvertState() {
  await writeState({ completedIds: [], lastRunAt: null });
}
