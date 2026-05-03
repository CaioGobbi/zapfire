// ============================================================
// ZAPFIRE — Storage (IndexedDB)
// ============================================================
// Wrapper sobre o IndexedDB nativo, expondo uma API com Promises
// pra três object stores:
//   - items   → scripts, áudios, imagens, vídeos, arquivos
//   - funnels → funis (sequências de items com delay)
//   - meta    → key-value solto (preferências da UI)
//
// Estratégia de origem:
//   Esse módulo é usado SEMPRE sob a origem da extensão
//   (chrome-extension://...). A sidebar é injetada como iframe
//   pra rodar na mesma origem do manager — assim os dados são
//   compartilhados entre as duas telas.
//
// Tudo ES Module. Tudo Promise. Sem dependências externas.
// ============================================================

const DB_NAME = 'zapfire_db';
const DB_VERSION = 2;

const STORE_ITEMS = 'items';
const STORE_FUNNELS = 'funnels';
const STORE_META = 'meta';
// Sprint 5 — runs de funis monitorados (trackingEnabled). Cada execução
// gera 1 entry; quem não tem tracking não cria nada (zero ruído).
const STORE_FUNNEL_RUNS = 'funnel_runs';

// Cache da conexão — IndexedDB é caro pra abrir, mantém vivo
let dbPromise = null;

// ------------------------------------------------------------
// Conexão
// ------------------------------------------------------------
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      // ----- v1: cria os 3 stores -----
      if (oldVersion < 1) {
        const items = db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
        items.createIndex('type', 'type', { unique: false });
        items.createIndex('createdAt', 'createdAt', { unique: false });
        items.createIndex('folder', 'folder', { unique: false });

        db.createObjectStore(STORE_FUNNELS, { keyPath: 'id' });
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }

      // ----- v2 (Sprint 5): adiciona store de runs de tracking -----
      // Não toca nas stores existentes. Migration de items/funnels é
      // tratada via withItemDefaults / withFunnelDefaults na leitura.
      if (oldVersion < 2) {
        const runs = db.createObjectStore(STORE_FUNNEL_RUNS, { keyPath: 'id' });
        // [funnelId, startedAt] — relatório por funil ordenado por tempo
        runs.createIndex('funnelId_startedAt', ['funnelId', 'startedAt'], { unique: false });
        // [status, startedAt] — runs ativos vs concluídos com ordenação
        runs.createIndex('status_startedAt', ['status', 'startedAt'], { unique: false });
        // leadJid — futuro: query "qual histórico de funis pra esse lead"
        runs.createIndex('leadJid', 'leadJid', { unique: false });
        // startedAt simples — usado pra retention policy (deleteRunsOlderThan)
        runs.createIndex('startedAt', 'startedAt', { unique: false });
      }

      // Próximas versões viriam aqui (oldVersion < 3 etc)
    };

    req.onsuccess = () => {
      const db = req.result;
      // Se a conexão for fechada por outro contexto (ex: outro tab
      // forçando upgrade), invalida o cache pra reconectar.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueado — feche outras abas da extensão'));
  });

  return dbPromise;
}

// ------------------------------------------------------------
// Helper genérico — envolve uma operação numa Promise
// ------------------------------------------------------------
function tx(storeName, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);

        let result;
        // O callback recebe o store e pode retornar:
        //   - um IDBRequest (pega o resultado dele no oncomplete)
        //   - um valor direto (será o resultado)
        //   - undefined (resultado fica undefined)
        const maybeReq = fn(store);

        if (maybeReq && typeof maybeReq === 'object' && 'onsuccess' in maybeReq) {
          maybeReq.onsuccess = () => (result = maybeReq.result);
          maybeReq.onerror = () => reject(maybeReq.error);
        } else {
          result = maybeReq;
        }

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
      })
  );
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
function uuid() {
  // crypto.randomUUID disponível em qualquer contexto da extensão
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

// ============================================================
// ITEMS — scripts, áudios, mídias
// ============================================================

// Schema esperado de um item:
// {
//   id: string,
//   type: 'text' | 'audio' | 'image' | 'video' | 'file',
//   title: string,
//   content: string | Blob,
//   mimeType?: string,
//   size?: number,
//   duration?: number,
//   thumbnail?: Blob,
//   folder?: string,
//   tags?: string[],
//   createdAt: number,
//   updatedAt: number,
//   uses: number,
//
//   // ----- Campos de envio (compatibilidade com formato ZapVoice) -----
//   // Adicionados no Sprint de import/export. Itens antigos no banco
//   // não têm esses campos e devem ser lidos com `?? default`.
//   // O sender ainda não consome todos — fica pra iteração futura.
//   isPtt?: boolean,        // só p/ audio. Default true (envia como mensagem de voz)
//   isPtv?: boolean,        // só p/ video. Default false (envia como vídeo redondo / PTV)
//   asViewOnce?: boolean,   // p/ áudio/imagem/vídeo. Default false
//   mentionUsers?: string,  // default "none". Enum futuro
//   isFavorite?: boolean,   // pinado na sidebar. Default false
//   caption?: string,       // legenda p/ mídias. Default ""
//   fileName?: string,      // só p/ type='file'. Preserva nome original
// }

const VALID_TYPES = new Set(['text', 'audio', 'image', 'video', 'file']);

// Defaults dos campos novos por tipo de item. Usado tanto no add
// quanto pra normalizar items legados na leitura (via withDefaults).
function defaultsForType(type) {
  const base = {
    isFavorite: false,
    mentionUsers: 'none',
  };
  switch (type) {
    case 'audio':
      return { ...base, isPtt: true, asViewOnce: false };
    case 'video':
      return { ...base, isPtv: false, asViewOnce: false, caption: '' };
    case 'image':
      return { ...base, asViewOnce: false, caption: '' };
    case 'file':
      return { ...base, caption: '', fileName: null };
    case 'text':
    default:
      return base;
  }
}

// Normaliza um item lido do banco aplicando defaults dos campos novos.
// Não muda o que já existe — só preenche o que está undefined.
// Exportado pra quem precisar uniformizar (ex: backup, sender).
export function withItemDefaults(item) {
  if (!item) return item;
  const defs = defaultsForType(item.type);
  const out = { ...item };
  for (const k of Object.keys(defs)) {
    if (out[k] === undefined) out[k] = defs[k];
  }
  return out;
}

function validateItemInput(item) {
  if (!item || typeof item !== 'object') {
    throw new Error('Item precisa ser um objeto');
  }
  if (!VALID_TYPES.has(item.type)) {
    throw new Error(`Tipo inválido: ${item.type}`);
  }
  if (!item.title || typeof item.title !== 'string') {
    throw new Error('Item precisa de título');
  }
  if (item.content == null) {
    throw new Error('Item precisa de conteúdo');
  }
}

// Pega só os campos novos de um input, aplicando defaults por tipo.
// Mantém valores explícitos (incluindo `false`/`""`) — só substitui
// undefined/null pelos defaults.
function extractExtendedFields(input, type) {
  const defs = defaultsForType(type);
  const out = {};
  for (const k of Object.keys(defs)) {
    const v = input[k];
    out[k] = v === undefined || v === null ? defs[k] : v;
  }
  // fileName só faz sentido pra 'file' — pra outros tipos, ignora
  if (type !== 'file' && 'fileName' in out) delete out.fileName;
  return out;
}

export async function addItem(input) {
  validateItemInput(input);

  const item = {
    id: input.id || uuid(),
    type: input.type,
    title: input.title.trim(),
    content: input.content,
    mimeType: input.mimeType || null,
    size: input.size ?? (input.content instanceof Blob ? input.content.size : null),
    duration: input.duration ?? null,
    thumbnail: input.thumbnail || null,
    folder: input.folder || null,
    tags: Array.isArray(input.tags) ? input.tags.filter(Boolean) : [],
    createdAt: input.createdAt || now(),
    updatedAt: now(),
    uses: input.uses || 0,
    ...extractExtendedFields(input, input.type),
  };

  await tx(STORE_ITEMS, 'readwrite', (store) => store.add(item));
  return item;
}

export async function getItem(id) {
  if (!id) return null;
  const raw = await tx(STORE_ITEMS, 'readonly', (store) => store.get(id));
  return raw ? withItemDefaults(raw) : raw;
}

// Filtros suportados:
//   type:   'text' | 'audio' | ... (filtro exato)
//   folder: string (filtro exato; null casa items sem pasta)
//   tags:   string[] (item precisa ter TODAS as tags pedidas)
// Resultado vem ordenado por createdAt DESC (mais novo primeiro).
export async function listItems(filters = {}) {
  const raw = await tx(STORE_ITEMS, 'readonly', (store) => store.getAll());
  const all = raw.map(withItemDefaults);

  let results = all;

  if (filters.type) {
    results = results.filter((it) => it.type === filters.type);
  }

  if (filters.folder !== undefined) {
    results = results.filter((it) => (it.folder || null) === (filters.folder || null));
  }

  if (filters.tags && filters.tags.length) {
    const wanted = filters.tags.map((t) => t.toLowerCase());
    results = results.filter((it) => {
      const itTags = (it.tags || []).map((t) => t.toLowerCase());
      return wanted.every((t) => itTags.includes(t));
    });
  }

  if (filters.search) {
    const q = filters.search.toLowerCase();
    results = results.filter((it) => {
      if (it.title.toLowerCase().includes(q)) return true;
      if (typeof it.content === 'string' && it.content.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  // Sort: items com sortOrder explícito vão na ordem definida pelo
  // user (drag-and-drop). Items sem sortOrder caem pra "newest first"
  // (createdAt DESC). Mistura: items sem sortOrder aparecem ANTES dos
  // com sortOrder pra que adições novas fiquem no topo. Isso é feito
  // tratando undefined como -Infinity no sort key.
  const orderKey = (it) => (typeof it.sortOrder === 'number' ? it.sortOrder : -it.createdAt);
  results.sort((a, b) => orderKey(a) - orderKey(b));
  return results;
}

// Reordena items pela ordem dos IDs passados — atribui sortOrder
// 0, 1, 2, ... pros items listados, na ordem. Items não listados
// preservam seu sortOrder atual (ou ficam sem). Usado pelo drag-drop
// do list view. Batch numa única IndexedDB transaction.
export async function reorderItems(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;
  await tx(STORE_ITEMS, 'readwrite', (store) => {
    // Dispara get + put pra cada id. A transaction só completa
    // depois que todos os onsuccess + put terminarem.
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      const idx = i;
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const item = getReq.result;
        if (item) {
          item.sortOrder = idx;
          store.put(item);
        }
      };
    }
    return undefined;
  });
}

// Atualiza um item parcial. Faz merge com o existente.
export async function updateItem(id, patch) {
  if (!id) throw new Error('updateItem precisa de id');
  const current = await getItem(id);
  if (!current) throw new Error(`Item não encontrado: ${id}`);

  const updated = {
    ...current,
    ...patch,
    id: current.id, // protege o id
    createdAt: current.createdAt, // não rebobina
    updatedAt: now(),
  };

  // Re-valida tipo se foi alterado
  if (patch.type && !VALID_TYPES.has(patch.type)) {
    throw new Error(`Tipo inválido: ${patch.type}`);
  }

  await tx(STORE_ITEMS, 'readwrite', (store) => store.put(updated));
  return updated;
}

// Sobrescreve um item por id (cria ou substitui). Diferente do
// updateItem — aceita o objeto inteiro como veio (preserva createdAt
// do input se vier, não força merge). Usado pelo import de backup
// quando o modo é "overwrite".
export async function putItem(item) {
  validateItemInput(item);
  const normalized = {
    id: item.id || uuid(),
    type: item.type,
    title: item.title.trim(),
    content: item.content,
    mimeType: item.mimeType ?? null,
    size: item.size ?? (item.content instanceof Blob ? item.content.size : null),
    duration: item.duration ?? null,
    thumbnail: item.thumbnail ?? null,
    folder: item.folder ?? null,
    tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : [],
    createdAt: item.createdAt || now(),
    updatedAt: now(),
    uses: item.uses || 0,
    ...extractExtendedFields(item, item.type),
  };
  await tx(STORE_ITEMS, 'readwrite', (store) => store.put(normalized));
  return normalized;
}

// Helper específico — incrementa o contador de envios
export async function incrementItemUses(id) {
  const current = await getItem(id);
  if (!current) return null;
  const updated = { ...current, uses: (current.uses || 0) + 1, updatedAt: now() };
  await tx(STORE_ITEMS, 'readwrite', (store) => store.put(updated));
  return updated;
}

export async function deleteItem(id) {
  if (!id) return false;
  await tx(STORE_ITEMS, 'readwrite', (store) => store.delete(id));
  return true;
}

// ============================================================
// FUNNELS — sequências de items com delay entre cada step
// ============================================================

// Schema:
// {
//   id: string,
//   name: string,
//   steps: [{ itemId: string, delayMs: number }, ...],
//   createdAt: number,
//   updatedAt: number,
//
//   // ----- Sprint 5 — tracking opt-in (todos opcionais, default false/null) -----
//   trackingEnabled?:    boolean   // ativa criação de funnel_runs
//   trackingLabel?:      string    // nome customizado pro relatório
//   notifyOnComplete?:   boolean   // toast em tempo real (Pro)
//   dailyReportEnabled?: boolean   // entra no daily report do WhatsApp (Pro)
//   isFavorite?:         boolean   // import/export ZapVoice
// }

// Defaults dos campos novos. Aplicados em withFunnelDefaults na leitura.
function defaultsForFunnel() {
  return {
    trackingEnabled: false,
    trackingLabel: null,
    notifyOnComplete: false,
    dailyReportEnabled: false,
    isFavorite: false,
  };
}

// Normaliza funil lido do banco aplicando defaults. Não muda o que já
// existe — só preenche o que está undefined. Itens antigos continuam
// funcionando sem migration.
export function withFunnelDefaults(funnel) {
  if (!funnel) return funnel;
  const defs = defaultsForFunnel();
  const out = { ...funnel };
  for (const k of Object.keys(defs)) {
    if (out[k] === undefined) out[k] = defs[k];
  }
  return out;
}

// Pega só os campos novos de um input, aplicando defaults se ausentes.
// Mantém valores explícitos (incluindo `false`).
function extractFunnelExtendedFields(input) {
  const defs = defaultsForFunnel();
  const out = {};
  for (const k of Object.keys(defs)) {
    const v = input[k];
    out[k] = v === undefined || v === null ? defs[k] : v;
  }
  return out;
}

function validateFunnelInput(funnel) {
  if (!funnel || typeof funnel !== 'object') {
    throw new Error('Funil precisa ser um objeto');
  }
  if (!funnel.name || typeof funnel.name !== 'string') {
    throw new Error('Funil precisa de nome');
  }
  if (!Array.isArray(funnel.steps)) {
    throw new Error('Funil precisa de array de steps');
  }
  for (const step of funnel.steps) {
    if (!step || typeof step.itemId !== 'string') {
      throw new Error('Cada step precisa de itemId');
    }
    if (typeof step.delayMs !== 'number' || step.delayMs < 0) {
      throw new Error('Cada step precisa de delayMs >= 0');
    }
  }
}

export async function addFunnel(input) {
  validateFunnelInput(input);

  const funnel = {
    id: input.id || uuid(),
    name: input.name.trim(),
    steps: input.steps.map((s) => ({
      itemId: s.itemId,
      delayMs: Math.max(0, Math.floor(s.delayMs)),
    })),
    createdAt: input.createdAt || now(),
    updatedAt: now(),
    ...extractFunnelExtendedFields(input),
  };

  await tx(STORE_FUNNELS, 'readwrite', (store) => store.add(funnel));
  return funnel;
}

export async function getFunnel(id) {
  if (!id) return null;
  const raw = await tx(STORE_FUNNELS, 'readonly', (store) => store.get(id));
  return raw ? withFunnelDefaults(raw) : raw;
}

export async function listFunnels() {
  const raw = await tx(STORE_FUNNELS, 'readonly', (store) => store.getAll());
  const all = raw.map(withFunnelDefaults);
  // Mesmo critério dos items (drag-and-drop reorder): sortOrder
  // explícito vence; sem ele, cai pra createdAt DESC.
  const orderKey = (f) => (typeof f.sortOrder === 'number' ? f.sortOrder : -f.createdAt);
  all.sort((a, b) => orderKey(a) - orderKey(b));
  return all;
}

// Reordena funis pela ordem dos IDs passados. Mesmo padrão do
// reorderItems — atribui sortOrder 0..N na ordem listada, batch
// transaction. Usado pelo drag-and-drop do funnel list view.
export async function reorderFunnels(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;
  await tx(STORE_FUNNELS, 'readwrite', (store) => {
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      const idx = i;
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const f = getReq.result;
        if (f) {
          f.sortOrder = idx;
          store.put(f);
        }
      };
    }
    return undefined;
  });
}

export async function updateFunnel(id, patch) {
  if (!id) throw new Error('updateFunnel precisa de id');
  const current = await getFunnel(id);
  if (!current) throw new Error(`Funil não encontrado: ${id}`);

  const merged = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: now(),
  };

  // Re-valida só se steps ou name mudaram
  if (patch.name !== undefined || patch.steps !== undefined) {
    validateFunnelInput(merged);
    merged.steps = merged.steps.map((s) => ({
      itemId: s.itemId,
      delayMs: Math.max(0, Math.floor(s.delayMs)),
    }));
  }

  await tx(STORE_FUNNELS, 'readwrite', (store) => store.put(merged));
  return merged;
}

// Análogo a putItem — sobrescreve um funil por id (cria ou substitui).
// Preserva createdAt do input se vier (importante pro import).
export async function putFunnel(input) {
  validateFunnelInput(input);
  const funnel = {
    id: input.id || uuid(),
    name: input.name.trim(),
    steps: input.steps.map((s) => ({
      itemId: s.itemId,
      delayMs: Math.max(0, Math.floor(s.delayMs)),
    })),
    createdAt: input.createdAt || now(),
    updatedAt: now(),
    ...extractFunnelExtendedFields(input),
  };
  await tx(STORE_FUNNELS, 'readwrite', (store) => store.put(funnel));
  return funnel;
}

export async function deleteFunnel(id) {
  if (!id) return false;
  await tx(STORE_FUNNELS, 'readwrite', (store) => store.delete(id));
  return true;
}

// Apaga TUDO — items + funis + runs de tracking. Meta preservado
// (preferências da UI, configuração de daily report).
export async function clearAll() {
  const [itemsCount, funnelsCount, runsCount] = await Promise.all([
    tx(STORE_ITEMS, 'readonly', (store) => store.count()),
    tx(STORE_FUNNELS, 'readonly', (store) => store.count()),
    tx(STORE_FUNNEL_RUNS, 'readonly', (store) => store.count()),
  ]);
  await Promise.all([
    tx(STORE_ITEMS, 'readwrite', (store) => store.clear()),
    tx(STORE_FUNNELS, 'readwrite', (store) => store.clear()),
    tx(STORE_FUNNEL_RUNS, 'readwrite', (store) => store.clear()),
  ]);
  return { clearedItems: itemsCount, clearedFunnels: funnelsCount, clearedRuns: runsCount };
}

// ============================================================
// FUNNEL_RUNS — execuções de funis monitorados (Sprint 5)
// ============================================================
//
// Schema:
// {
//   id:             string (uuid),
//   funnelId:       string,
//   funnelName:     string,           // snapshot p/ caso o funil seja
//                                     // renomeado/deletado depois
//   leadJid:        string,           // ex: "5541999999999@c.us"
//   leadName:       string | null,
//
//   startedAt:      number (ms),
//   finishedAt:     number | null,
//
//   totalSteps:     number,           // tamanho do funil quando rodou
//   completedSteps: number,           // quantos disparados com sucesso
//
//   status: 'running' | 'completed' | 'cancelled' | 'failed',
//
//   steps: [
//     { stepId, type, sentAt, success, error? }
//   ]
// }
//
// Indexes (criados na v2 do DB):
//   - funnelId_startedAt: pra "runs do funil X ordenados por tempo"
//   - status_startedAt:   pra "runs ativos / concluídos com filtro temporal"
//   - leadJid:            pra "histórico do lead Y"
//   - startedAt:          pra retention policy (deleteRunsOlderThan)
// ============================================================

const VALID_RUN_STATUS = new Set(['running', 'completed', 'cancelled', 'failed']);

function validateRunInput(run) {
  if (!run || typeof run !== 'object') {
    throw new Error('Run precisa ser um objeto');
  }
  if (typeof run.funnelId !== 'string' || !run.funnelId) {
    throw new Error('Run precisa de funnelId');
  }
  if (typeof run.leadJid !== 'string' || !run.leadJid) {
    throw new Error('Run precisa de leadJid');
  }
  if (run.status && !VALID_RUN_STATUS.has(run.status)) {
    throw new Error(`Status de run inválido: ${run.status}`);
  }
}

export async function addRun(input) {
  validateRunInput(input);
  const run = {
    id: input.id || uuid(),
    funnelId: input.funnelId,
    funnelName: input.funnelName || '',
    leadJid: input.leadJid,
    leadName: input.leadName || null,
    startedAt: input.startedAt || now(),
    finishedAt: input.finishedAt || null,
    totalSteps: input.totalSteps || 0,
    completedSteps: input.completedSteps || 0,
    status: input.status || 'running',
    steps: Array.isArray(input.steps) ? input.steps : [],
  };
  await tx(STORE_FUNNEL_RUNS, 'readwrite', (store) => store.add(run));
  return run;
}

export async function getRun(id) {
  if (!id) return null;
  return tx(STORE_FUNNEL_RUNS, 'readonly', (store) => store.get(id));
}

// Patch parcial — faz merge com o existente. Se passar `steps`, SUBSTITUI
// o array (não concatena). Pra append de step, leia o run atual antes.
export async function updateRun(id, patch) {
  if (!id) throw new Error('updateRun precisa de id');
  const current = await getRun(id);
  if (!current) throw new Error(`Run não encontrado: ${id}`);
  const merged = {
    ...current,
    ...patch,
    id: current.id,             // protege id
    funnelId: current.funnelId, // não permite re-anchor
    startedAt: current.startedAt,
  };
  if (patch.status && !VALID_RUN_STATUS.has(patch.status)) {
    throw new Error(`Status de run inválido: ${patch.status}`);
  }
  await tx(STORE_FUNNEL_RUNS, 'readwrite', (store) => store.put(merged));
  return merged;
}

// Filtros suportados:
//   funnelId: string         — só runs daquele funil
//   status:   string         — só de um status
//   since:    number (ms)    — startedAt >= since
//   until:    number (ms)    — startedAt <= until
//   limit:    number         — corta após N (default sem limite)
//
// Resultado vem ordenado por startedAt DESC (mais recente primeiro).
export async function listRuns(filters = {}) {
  const all = await tx(STORE_FUNNEL_RUNS, 'readonly', (store) => store.getAll());

  let results = all;
  if (filters.funnelId) {
    results = results.filter((r) => r.funnelId === filters.funnelId);
  }
  if (filters.status) {
    results = results.filter((r) => r.status === filters.status);
  }
  if (typeof filters.since === 'number') {
    results = results.filter((r) => r.startedAt >= filters.since);
  }
  if (typeof filters.until === 'number') {
    results = results.filter((r) => r.startedAt <= filters.until);
  }

  results.sort((a, b) => b.startedAt - a.startedAt);

  if (typeof filters.limit === 'number' && filters.limit > 0) {
    results = results.slice(0, filters.limit);
  }
  return results;
}

export async function deleteRun(id) {
  if (!id) return false;
  await tx(STORE_FUNNEL_RUNS, 'readwrite', (store) => store.delete(id));
  return true;
}

// Retention policy — apaga runs com startedAt < olderThanMs.
// Usar `Date.now() - 90 * 86400000` pra retenção de 90 dias.
// Retorna quantos foram apagados.
export async function deleteRunsOlderThan(olderThanMs) {
  if (typeof olderThanMs !== 'number') return 0;
  return openDB().then((db) =>
    new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_FUNNEL_RUNS, 'readwrite');
      const store = transaction.objectStore(STORE_FUNNEL_RUNS);
      const idx = store.index('startedAt');
      const range = IDBKeyRange.upperBound(olderThanMs, true); // exclusivo
      const cursorReq = idx.openCursor(range);
      let count = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          count++;
          cursor.continue();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
      transaction.oncomplete = () => resolve(count);
      transaction.onerror = () => reject(transaction.error);
    })
  );
}

// ============================================================
// META — key-value solto (preferências da UI)
// ============================================================

export async function setMeta(key, value) {
  if (!key) throw new Error('setMeta precisa de key');
  await tx(STORE_META, 'readwrite', (store) => store.put({ key, value, updatedAt: now() }));
  return value;
}

export async function getMeta(key, defaultValue = null) {
  if (!key) return defaultValue;
  const row = await tx(STORE_META, 'readonly', (store) => store.get(key));
  return row ? row.value : defaultValue;
}

export async function deleteMeta(key) {
  if (!key) return false;
  await tx(STORE_META, 'readwrite', (store) => store.delete(key));
  return true;
}

// ============================================================
// EXPORT / IMPORT — backup completo do banco
// ============================================================
// Útil pro botão "Exportar tudo" do manager. Items com Blob são
// convertidos pra base64 pra caber em JSON. Não é eficiente em
// memória, mas pra biblioteca pessoal funciona.

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // data: URL completa
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function base64ToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function serializeItem(item) {
  const out = { ...item };
  if (item.content instanceof Blob) {
    out.content = await blobToBase64(item.content);
    out._contentIsBlob = true;
  }
  if (item.thumbnail instanceof Blob) {
    out.thumbnail = await blobToBase64(item.thumbnail);
    out._thumbnailIsBlob = true;
  }
  return out;
}

async function deserializeItem(raw) {
  const out = { ...raw };
  if (raw._contentIsBlob && typeof raw.content === 'string') {
    out.content = await base64ToBlob(raw.content);
    delete out._contentIsBlob;
  }
  if (raw._thumbnailIsBlob && typeof raw.thumbnail === 'string') {
    out.thumbnail = await base64ToBlob(raw.thumbnail);
    delete out._thumbnailIsBlob;
  }
  return out;
}

export async function exportAll() {
  const [items, funnels] = await Promise.all([listItems(), listFunnels()]);
  const serializedItems = await Promise.all(items.map(serializeItem));
  return {
    version: 1,
    exportedAt: now(),
    items: serializedItems,
    funnels,
  };
}

// importAll aceita o JSON gerado por exportAll. Faz merge: items
// com mesmo id são sobrescritos (put), novos são criados.
export async function importAll(payload, { replace = false } = {}) {
  if (!payload || payload.version !== 1) {
    throw new Error('Backup com versão incompatível');
  }

  if (replace) {
    await tx(STORE_ITEMS, 'readwrite', (store) => store.clear());
    await tx(STORE_FUNNELS, 'readwrite', (store) => store.clear());
  }

  let importedItems = 0;
  let importedFunnels = 0;

  for (const raw of payload.items || []) {
    const item = await deserializeItem(raw);
    await tx(STORE_ITEMS, 'readwrite', (store) => store.put(item));
    importedItems++;
  }

  for (const funnel of payload.funnels || []) {
    await tx(STORE_FUNNELS, 'readwrite', (store) => store.put(funnel));
    importedFunnels++;
  }

  return { importedItems, importedFunnels };
}
