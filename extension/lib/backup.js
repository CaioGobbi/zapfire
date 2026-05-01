// ============================================================
// ZAPFIRE — Backup (export / import) compatível com ZapVoice 3.0.0
// ============================================================
// Permite que usuários migrem do ZapVoice pro Zapfire e vice-versa
// sem perder conteúdo. O formato é o JSON exato do "Exportar
// backup" do ZapVoice — assim o cliente pode trocar de produto
// preservando funis, scripts, áudios e mídias.
//
// Schema raiz (ZapVoice 3.0.0):
// {
//   version: "3.0.0",
//   type: "full" | "partial",
//   audios:    [{ id, name, isPtt, isFavorite, asViewOnce, mentionUsers }],
//   medias:    [{ id, name, isFavorite, asViewOnce, isPtv, mentionUsers }],
//   docs:      [{ id, name, isFavorite, mentionUsers }],
//   messages:  [{ id, name, isFavorite, mentionUsers }],
//   funnels:   [{ id, name, isFavorite, itemsSequence: [{...}] }],
//   flows:     [],   // não implementado no Zapfire (ainda)
//   triggers:  [],   // não implementado (Sprint 5 futuro)
//   labels:    [],   // não implementado
//   objectsList: [   // conteúdo binário/texto associado por id
//     { id, isPtt, data: "data:audio/..." }            // áudio
//     { id, fileName, data: "data:image/..." }         // doc
//     { id, caption, data: "data:image/..." }          // mídia
//     { id, data: "texto cru" }                        // message
//   ]
// }
//
// Mapeamento ZV → Zapfire (interno):
//   audios[]                → type='audio'  (preserva isPtt, asViewOnce, ...)
//   medias[] image MIME     → type='image'  (caption, asViewOnce, ...)
//   medias[] video MIME     → type='video'  (isPtv, caption, ...)
//   docs[]                  → type='file'   (fileName preservado)
//   messages[]              → type='text'   (content = string crua)
//
// Comentários em PT, ES module, async/await, sem libs externas.
// ============================================================

import {
  listItems,
  listFunnels,
  getItem,
  getFunnel,
  addItem,
  addFunnel,
  putItem,
  putFunnel,
  withItemDefaults,
} from './storage.js';

export const SCHEMA_VERSION = '3.0.0';

// ------------------------------------------------------------
// Helpers genéricos
// ------------------------------------------------------------

function uuid() {
  return crypto.randomUUID();
}

// Blob → "data:<mime>;base64,<...>"
async function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader falhou'));
    reader.readAsDataURL(blob);
  });
}

// "data:<mime>;base64,<...>" → Blob
// Aceita data URIs base64 (formato ZapVoice) e text/plain.
async function dataUriToBlob(dataUri) {
  if (typeof dataUri !== 'string') {
    throw new Error('dataUri precisa ser string');
  }
  if (!dataUri.startsWith('data:')) {
    throw new Error('dataUri inválido — não começa com "data:"');
  }
  // fetch() resolve data URIs nativamente em browser/extension
  const res = await fetch(dataUri);
  return res.blob();
}

// "data:image/png;base64,..." → "image/png"
function mimeOfDataUri(dataUri) {
  if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) return '';
  const semi = dataUri.indexOf(';');
  const comma = dataUri.indexOf(',');
  const end = semi !== -1 && (comma === -1 || semi < comma) ? semi : comma;
  return dataUri.slice(5, end === -1 ? undefined : end).toLowerCase();
}

// Lê duração (segundos, float) de um blob de áudio/vídeo via DOM.
// Retorna null se não conseguir (ex: codec desconhecido). Usado no
// import pra preencher item.duration — feature do step modal de
// funil que pré-preenche o delay com a duração do áudio.
function readBlobDuration(blob, kind) {
  return new Promise((resolve) => {
    if (!(blob instanceof Blob)) return resolve(null);
    let el;
    try {
      el = document.createElement(kind === 'video' ? 'video' : 'audio');
    } catch (_) { return resolve(null); }
    const url = URL.createObjectURL(blob);
    const cleanup = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = el.duration;
      cleanup();
      resolve(isFinite(d) && d > 0 ? d : null);
    };
    el.onerror = () => { cleanup(); resolve(null); };
    el.src = url;
  });
}

// MIME → tipo interno do Zapfire
function detectTypeFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

// ------------------------------------------------------------
// Mapeamento de tipo de step do funil
// ------------------------------------------------------------
// ZV usa: 'message' | 'audio' | 'media' | 'document'
// Zapfire usa o type do item (text/audio/image/video/file)

function stepTypeFromInternal(internalType) {
  switch (internalType) {
    case 'text': return 'message';
    case 'audio': return 'audio';
    case 'image': return 'media';
    case 'video': return 'media';
    case 'file': return 'document';
    default: return 'message';
  }
}

// ------------------------------------------------------------
// Leitura defensiva do input do import
// ------------------------------------------------------------
async function readInput(input) {
  if (typeof input === 'string') {
    return JSON.parse(input);
  }
  if (input && typeof input.text === 'function') {
    // File / Blob
    const text = await input.text();
    return JSON.parse(text);
  }
  if (input && typeof input === 'object') {
    // Já é objeto — usa direto
    return input;
  }
  throw new Error('Backup precisa ser File, Blob, string JSON ou objeto');
}

function validateBackupShape(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Backup precisa ser um objeto');
  }
  if (typeof data.version !== 'string') {
    throw new Error('Backup sem campo "version"');
  }
  if (!Array.isArray(data.objectsList)) {
    throw new Error('Backup sem array "objectsList"');
  }
  // Versão diferente de 3.x.x não é fatal — emite warning no caller
}

// ============================================================
// EXPORT
// ============================================================
// Lê items + funnels do storage e monta o JSON formato ZapVoice.
//
// options:
//   - includeUnused: boolean — futuro (atualmente exporta tudo)
//   - type: "full" | "partial" — default "full"
//
// Retorna Blob pronto pra download (application/json).
// ------------------------------------------------------------
export async function exportBackup(options = {}) {
  const type = options.type === 'partial' ? 'partial' : 'full';
  const items = await listItems();
  const funnels = await listFunnels();

  const audios = [];
  const medias = [];
  const docs = [];
  const messages = [];
  const objectsList = [];

  // -------- Itens --------
  for (const rawItem of items) {
    const item = withItemDefaults(rawItem); // garante defaults dos campos novos
    try {
      switch (item.type) {
        case 'audio': {
          audios.push({
            id: item.id,
            name: item.title,
            isPtt: item.isPtt ?? true,
            isFavorite: item.isFavorite ?? false,
            asViewOnce: item.asViewOnce ?? false,
            mentionUsers: item.mentionUsers ?? 'none',
          });
          objectsList.push({
            id: item.id,
            isPtt: item.isPtt ?? true,
            data: await blobToDataUri(item.content),
          });
          break;
        }
        case 'image':
        case 'video': {
          medias.push({
            id: item.id,
            name: item.title,
            isFavorite: item.isFavorite ?? false,
            asViewOnce: item.asViewOnce ?? false,
            isPtv: item.type === 'video' ? (item.isPtv ?? false) : false,
            mentionUsers: item.mentionUsers ?? 'none',
          });
          objectsList.push({
            id: item.id,
            caption: item.caption ?? '',
            data: await blobToDataUri(item.content),
          });
          break;
        }
        case 'file': {
          docs.push({
            id: item.id,
            name: item.title,
            isFavorite: item.isFavorite ?? false,
            mentionUsers: item.mentionUsers ?? 'none',
          });
          objectsList.push({
            id: item.id,
            fileName: item.fileName ?? item.title,
            data: await blobToDataUri(item.content),
          });
          break;
        }
        case 'text': {
          messages.push({
            id: item.id,
            name: item.title,
            isFavorite: item.isFavorite ?? false,
            mentionUsers: item.mentionUsers ?? 'none',
          });
          objectsList.push({
            id: item.id,
            data: typeof item.content === 'string' ? item.content : '',
          });
          break;
        }
        default:
          // Tipo desconhecido — ignora silenciosamente
          break;
      }
    } catch (err) {
      console.warn('[backup:export] falha em item', item.id, err);
    }
  }

  // -------- Funis --------
  // Pra cada funil, construímos itemsSequence consultando o type
  // dos items referenciados (necessário pro step.type do ZV).
  // Pra evitar N getItems, monta um índice id→type a partir dos items
  // já carregados.
  const itemTypeIndex = new Map();
  for (const it of items) itemTypeIndex.set(it.id, it.type);

  const funnelsOut = [];
  for (const f of funnels) {
    const itemsSequence = [];
    for (const step of f.steps || []) {
      const internalType = itemTypeIndex.get(step.itemId);
      if (!internalType) {
        // Item referenciado não existe mais — preserva o step mas sem type confiável
        itemsSequence.push({
          id: uuid(),
          funnelId: f.id,
          itemId: step.itemId,
          type: 'message',
          delayBeforeSend: Math.max(0, Math.floor(step.delayMs || 0)),
        });
        continue;
      }
      itemsSequence.push({
        id: uuid(),
        funnelId: f.id,
        itemId: step.itemId,
        type: stepTypeFromInternal(internalType),
        delayBeforeSend: Math.max(0, Math.floor(step.delayMs || 0)),
      });
    }
    funnelsOut.push({
      id: f.id,
      name: f.name,
      isFavorite: f.isFavorite ?? false,
      itemsSequence,
    });
  }

  const payload = {
    version: SCHEMA_VERSION,
    type,
    audios,
    docs,
    medias,
    messages,
    funnels: funnelsOut,
    flows: [],
    triggers: [],
    labels: [],
    objectsList,
  };

  const json = JSON.stringify(payload);
  return new Blob([json], { type: 'application/json;charset=utf-8' });
}

// ============================================================
// PREVIEW — devolve só contagens sem escrever no storage
// ============================================================
// Útil pra UI mostrar "Você tá pra importar 3 áudios, 2 mídias..."
// antes do usuário confirmar.
// ------------------------------------------------------------
export async function previewBackup(input) {
  const data = await readInput(input);
  validateBackupShape(data);

  const objIndex = indexObjectsList(data.objectsList);
  const orphanIds = [];

  function countWithObjs(metadata = []) {
    let withObj = 0;
    for (const m of metadata) {
      if (m && m.id && objIndex.has(m.id)) withObj++;
      else if (m && m.id) orphanIds.push(m.id);
    }
    return withObj;
  }

  return {
    version: data.version,
    type: data.type || 'full',
    counts: {
      audios: countWithObjs(data.audios),
      medias: countWithObjs(data.medias),
      docs: countWithObjs(data.docs),
      messages: countWithObjs(data.messages),
      funnels: Array.isArray(data.funnels) ? data.funnels.length : 0,
    },
    orphans: orphanIds,
    versionMismatch: !data.version.startsWith('3.'),
  };
}

// ============================================================
// IMPORT
// ============================================================
// Consome um backup (File / Blob / string JSON / objeto) e grava
// no storage local.
//
// options:
//   - conflictMode: 'skip' | 'overwrite' | 'rename' (default 'skip')
//       skip      — se id já existe no storage, ignora
//       overwrite — usa putItem/putFunnel pra substituir
//       rename    — gera novo id E adiciona " (importado)" ao name
//   - regenerateIds: boolean (default false)
//       Se true, gera UUIDs novos pra TODOS os items e funis,
//       atualizando referências em itemsSequence dos funis. Útil
//       pra fazer merge em conta já populada sem colisões.
//
// Retorna ImportReport:
//   {
//     version: "3.0.0",
//     imported: { audios, medias, docs, messages, funnels },
//     skipped:  { audios, medias, docs, messages, funnels },
//     orphans:  [<id>, ...],     // ids referenciados sem objeto correspondente
//     errors:   [{ id?, kind, message }, ...]
//   }
// ------------------------------------------------------------
export async function importBackup(input, options = {}) {
  const conflictMode = options.conflictMode || 'skip';
  if (!['skip', 'overwrite', 'rename'].includes(conflictMode)) {
    throw new Error(`conflictMode inválido: ${conflictMode}`);
  }
  const regenerateIds = options.regenerateIds === true;

  const data = await readInput(input);
  validateBackupShape(data);

  const report = {
    version: data.version,
    imported: { audios: 0, medias: 0, docs: 0, messages: 0, funnels: 0 },
    skipped: { audios: 0, medias: 0, docs: 0, messages: 0, funnels: 0 },
    orphans: [],
    errors: [],
  };

  // Index dos objects pra lookup O(1)
  const objIndex = indexObjectsList(data.objectsList);

  // Mapping old id → new id (alimentado se regenerateIds=true OU
  // quando conflictMode='rename' encontra colisão).
  const idMap = new Map();

  // -------- Preservação de ordem --------
  // listItems / listFunnels ordenam por createdAt DESC. Pra que os
  // items apareçam na MESMA ordem do backup do ZapVoice, atribuímos
  // createdAt decrescente conforme processamos: o primeiro item do
  // backup recebe baseTime (mais novo), o segundo baseTime-1, etc.
  // Sem isso, todos os items pegam ~now() do storage (diferindo em
  // 0-1ms) e a ordem fica indeterminada.
  const importBaseTime = Date.now();
  let orderTickItem = 0;
  let orderTickFunnel = 0;
  const nextItemCreatedAt = () => importBaseTime - (orderTickItem++);
  const nextFunnelCreatedAt = () => importBaseTime - (orderTickFunnel++);

  // -------- Áudios --------
  for (const meta of data.audios || []) {
    try {
      const obj = objIndex.get(meta.id);
      if (!obj) {
        report.orphans.push(meta.id);
        report.skipped.audios++;
        continue;
      }
      const blob = await dataUriToBlob(obj.data);
      const newId = pickId(meta.id, regenerateIds, idMap);
      const duration = await readBlobDuration(blob, 'audio');
      const item = {
        id: newId,
        type: 'audio',
        title: meta.name || 'Áudio',
        content: blob,
        mimeType: blob.type || 'audio/ogg',
        size: blob.size,
        duration,
        createdAt: nextItemCreatedAt(),
        isPtt: typeof obj.isPtt === 'boolean' ? obj.isPtt : (meta.isPtt ?? true),
        asViewOnce: meta.asViewOnce ?? false,
        isFavorite: meta.isFavorite ?? false,
        mentionUsers: meta.mentionUsers || 'none',
      };
      const wrote = await writeItemWithConflict(item, conflictMode, idMap, meta.id);
      if (wrote) report.imported.audios++;
      else report.skipped.audios++;
    } catch (err) {
      report.errors.push({ id: meta?.id, kind: 'audio', message: err.message });
      report.skipped.audios++;
    }
  }

  // -------- Mídias (image / video) --------
  for (const meta of data.medias || []) {
    try {
      const obj = objIndex.get(meta.id);
      if (!obj) {
        report.orphans.push(meta.id);
        report.skipped.medias++;
        continue;
      }
      const blob = await dataUriToBlob(obj.data);
      const detected = detectTypeFromMime(blob.type || mimeOfDataUri(obj.data));
      // Detectado pode dar 'audio' / 'file' raramente — força image/video
      const internalType = detected === 'video' ? 'video' : 'image';
      const newId = pickId(meta.id, regenerateIds, idMap);
      const duration = internalType === 'video' ? await readBlobDuration(blob, 'video') : undefined;
      const item = {
        id: newId,
        type: internalType,
        title: meta.name || (internalType === 'video' ? 'Vídeo' : 'Imagem'),
        content: blob,
        mimeType: blob.type || (internalType === 'video' ? 'video/mp4' : 'image/jpeg'),
        size: blob.size,
        ...(duration ? { duration } : {}),
        createdAt: nextItemCreatedAt(),
        caption: typeof obj.caption === 'string' ? obj.caption : '',
        asViewOnce: meta.asViewOnce ?? false,
        isFavorite: meta.isFavorite ?? false,
        mentionUsers: meta.mentionUsers || 'none',
      };
      // isPtv só pra vídeo
      if (internalType === 'video') {
        item.isPtv = meta.isPtv ?? false;
      }
      const wrote = await writeItemWithConflict(item, conflictMode, idMap, meta.id);
      if (wrote) report.imported.medias++;
      else report.skipped.medias++;
    } catch (err) {
      report.errors.push({ id: meta?.id, kind: 'media', message: err.message });
      report.skipped.medias++;
    }
  }

  // -------- Documentos (file) --------
  for (const meta of data.docs || []) {
    try {
      const obj = objIndex.get(meta.id);
      if (!obj) {
        report.orphans.push(meta.id);
        report.skipped.docs++;
        continue;
      }
      const blob = await dataUriToBlob(obj.data);
      const newId = pickId(meta.id, regenerateIds, idMap);
      const item = {
        id: newId,
        type: 'file',
        title: meta.name || 'Documento',
        content: blob,
        mimeType: blob.type || 'application/octet-stream',
        size: blob.size,
        createdAt: nextItemCreatedAt(),
        fileName: obj.fileName || meta.name || 'arquivo',
        isFavorite: meta.isFavorite ?? false,
        mentionUsers: meta.mentionUsers || 'none',
      };
      const wrote = await writeItemWithConflict(item, conflictMode, idMap, meta.id);
      if (wrote) report.imported.docs++;
      else report.skipped.docs++;
    } catch (err) {
      report.errors.push({ id: meta?.id, kind: 'doc', message: err.message });
      report.skipped.docs++;
    }
  }

  // -------- Mensagens (text) --------
  for (const meta of data.messages || []) {
    try {
      const obj = objIndex.get(meta.id);
      if (!obj) {
        report.orphans.push(meta.id);
        report.skipped.messages++;
        continue;
      }
      // Mensagens trazem string crua em data — não é data URI
      const text = typeof obj.data === 'string' ? obj.data : '';
      const newId = pickId(meta.id, regenerateIds, idMap);
      const item = {
        id: newId,
        type: 'text',
        title: meta.name || 'Mensagem',
        content: text,
        size: text.length,
        createdAt: nextItemCreatedAt(),
        isFavorite: meta.isFavorite ?? false,
        mentionUsers: meta.mentionUsers || 'none',
      };
      const wrote = await writeItemWithConflict(item, conflictMode, idMap, meta.id);
      if (wrote) report.imported.messages++;
      else report.skipped.messages++;
    } catch (err) {
      report.errors.push({ id: meta?.id, kind: 'message', message: err.message });
      report.skipped.messages++;
    }
  }

  // -------- Funis --------
  // Importa POR ÚLTIMO, depois que o idMap tem todas as remapeações
  // de items (caso regenerateIds ou rename tenham mudado ids).
  for (const f of data.funnels || []) {
    try {
      const stepsRaw = Array.isArray(f.itemsSequence) ? f.itemsSequence : [];
      const steps = [];
      for (const s of stepsRaw) {
        if (!s || typeof s.itemId !== 'string') continue;
        // Se o item foi remapeado, usa o novo id
        const finalItemId = idMap.get(s.itemId) || s.itemId;
        steps.push({
          itemId: finalItemId,
          delayMs: Math.max(0, Math.floor(s.delayBeforeSend || 0)),
        });
      }
      if (!steps.length) {
        // Funil sem steps válidos — registra como skipped
        report.skipped.funnels++;
        continue;
      }
      const newId = pickId(f.id, regenerateIds, idMap);
      const funnel = {
        id: newId,
        name: f.name || 'Funil',
        steps,
        isFavorite: f.isFavorite ?? false,
        createdAt: nextFunnelCreatedAt(),
      };
      const wrote = await writeFunnelWithConflict(funnel, conflictMode, idMap, f.id);
      if (wrote) report.imported.funnels++;
      else report.skipped.funnels++;
    } catch (err) {
      report.errors.push({ id: f?.id, kind: 'funnel', message: err.message });
      report.skipped.funnels++;
    }
  }

  // Dedup de orphans (mesmo id pode aparecer em mais de um array)
  report.orphans = [...new Set(report.orphans)];

  return report;
}

// ============================================================
// Helpers internos do import
// ============================================================

function indexObjectsList(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const obj of list) {
    if (obj && typeof obj.id === 'string') map.set(obj.id, obj);
  }
  return map;
}

// Decide o id a usar pra inserir — se regenerateIds, gera novo
// e registra mapping. Senão usa o original.
function pickId(originalId, regenerateIds, idMap) {
  if (!regenerateIds) return originalId;
  const fresh = uuid();
  idMap.set(originalId, fresh);
  return fresh;
}

// Escreve item respeitando conflictMode. Retorna true se escreveu,
// false se pulou (skip) ou se houve qualquer erro silencioso.
async function writeItemWithConflict(item, conflictMode, idMap, originalId) {
  const exists = await getItem(item.id);

  if (!exists) {
    await addItem(item);
    return true;
  }

  switch (conflictMode) {
    case 'skip':
      return false;
    case 'overwrite':
      await putItem(item);
      return true;
    case 'rename': {
      const renamed = {
        ...item,
        id: uuid(),
        title: `${item.title} (importado)`,
      };
      // Registra mapping pra que funis que apontavam pra esse item
      // sigam a nova versão renomeada
      idMap.set(originalId, renamed.id);
      await addItem(renamed);
      return true;
    }
    default:
      return false;
  }
}

async function writeFunnelWithConflict(funnel, conflictMode, idMap, originalId) {
  const exists = await getFunnel(funnel.id);

  if (!exists) {
    await addFunnel(funnel);
    return true;
  }

  switch (conflictMode) {
    case 'skip':
      return false;
    case 'overwrite':
      await putFunnel(funnel);
      return true;
    case 'rename': {
      const renamed = {
        ...funnel,
        id: uuid(),
        name: `${funnel.name} (importado)`,
      };
      idMap.set(originalId, renamed.id);
      await addFunnel(renamed);
      return true;
    }
    default:
      return false;
  }
}

// ============================================================
// Helper conveniente pra UI — sugere nome de arquivo padrão
// ============================================================
export function suggestBackupFilename(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `zapfire_backup_${dd}_${mm}_${yyyy}.json`;
}
