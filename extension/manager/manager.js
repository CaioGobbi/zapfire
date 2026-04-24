// ============================================================
// ZAPFIRE — Manager (controller)
// ============================================================
// Tela completa pra:
//   - CRUD de items (text, audio, image, video, file)
//   - CRUD de funis (drag-and-drop de items pra steps + delays)
//   - Backup (export/import JSON)
//
// Roda em chrome-extension://...manager.html — mesma origem do
// IndexedDB usado pela sidebar, então tudo é compartilhado.
// ============================================================

import * as storage from '../lib/storage.js';
import { PANEL_URL } from '../config.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------
// Estado global
// ------------------------------------------------------------
const state = {
  filter: 'all',   // all | text | audio | image | video | file | funnels
  search: '',
  // Buffer do modal de item (sendo editado/criado)
  draftItem: null,
  // Buffer do modal de funil
  draftFunnel: null,
  // Cache de items pro pool do funnel editor
  poolItems: [],
  poolSearch: '',
};

// Quais types do storage cada filtro mostra
const FILTER_TYPES = {
  all: ['text', 'audio', 'image', 'video', 'file'],
  text: ['text'],
  audio: ['audio'],
  image: ['image'],
  video: ['video'],
  file: ['file'],
};

const TYPE_LABELS = {
  text: 'mensagem',
  audio: 'áudio',
  image: 'imagem',
  video: 'vídeo',
  file: 'arquivo',
};

// Gênero do substantivo (pra "Novo" vs "Nova")
const TYPE_GENDER = {
  text: 'f',
  audio: 'm',
  image: 'f',
  video: 'm',
  file: 'm',
};

// ============================================================
// TOAST
// ============================================================
let toastTimer = null;
function toast(message, type = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast ' + type;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

// ============================================================
// HELPERS
// ============================================================
function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseTags(str) {
  return (str || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function blobURL(blob) {
  return URL.createObjectURL(blob);
}

// ============================================================
// METADADOS DE MÍDIA — duração, thumbnail, waveform
// ============================================================

// Lê duração de um audio/video blob via elemento HTML
function getMediaDuration(blob, kind) {
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.src = blobURL(blob);
    el.onloadedmetadata = () => {
      const dur = el.duration;
      URL.revokeObjectURL(el.src);
      resolve(isFinite(dur) ? dur : null);
    };
    el.onerror = () => {
      URL.revokeObjectURL(el.src);
      resolve(null);
    };
  });
}

// Captura o primeiro frame visível de um vídeo como Blob (PNG)
function generateVideoThumbnail(blob) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = blobURL(blob);

    const cleanup = () => URL.revokeObjectURL(video.src);

    video.onloadedmetadata = () => {
      // Pula pra 0.5s pra evitar frame preto inicial
      video.currentTime = Math.min(0.5, (video.duration || 1) * 0.1);
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 240;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => {
        cleanup();
        resolve(b);
      }, 'image/jpeg', 0.7);
    };
    video.onerror = () => { cleanup(); resolve(null); };
  });
}

// Gera waveform visual de áudio em um <canvas>
async function drawWaveform(blob, canvas) {
  try {
    const arrayBuf = await blob.arrayBuffer();
    // OfflineAudioContext só pra decodificar — sem latência de playback
    const tempCtx = new OfflineAudioContext(1, 1, 44100);
    const audioBuf = await tempCtx.decodeAudioData(arrayBuf.slice(0));

    const data = audioBuf.getChannelData(0);
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.clientWidth * devicePixelRatio;
    const H = canvas.height = canvas.clientHeight * devicePixelRatio;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ff3b30';

    // Subamostra: agrupa amostras em "buckets" do tamanho de 1px
    const bucketCount = Math.floor(W / 2);
    const bucketSize = Math.floor(data.length / bucketCount);
    const half = H / 2;

    for (let i = 0; i < bucketCount; i++) {
      let max = 0;
      for (let j = 0; j < bucketSize; j++) {
        const v = Math.abs(data[i * bucketSize + j] || 0);
        if (v > max) max = v;
      }
      const barH = max * H * 0.9;
      ctx.fillRect(i * 2, half - barH / 2, 1, barH);
    }
    return audioBuf.duration;
  } catch (err) {
    console.warn('Falha ao gerar waveform:', err);
    return null;
  }
}

// ============================================================
// RENDERIZAÇÃO DA LISTA PRINCIPAL
// ============================================================

// Classe de cor pra badge+borda (agrupa image/video/file em "media"
// quando for no dashboard; na listagem individual usa o tipo bruto)
function typeColorKey(type) {
  if (type === 'text') return 'text';
  if (type === 'audio') return 'audio';
  if (type === 'image' || type === 'video' || type === 'file') return 'media';
  return 'funnel';
}

function badgeFor(type) {
  const map = { text: 'MSG', audio: 'ÁUDIO', image: 'IMG', video: 'VÍDEO', file: 'ARQ' };
  return map[type] || type.toUpperCase();
}

async function renderList() {
  const grid = $('grid');

  // Tab Tudo → dashboard
  if (state.filter === 'all' && !state.search) {
    await renderDashboard(grid);
    return;
  }

  if (state.filter === 'funnels') {
    const funnels = await storage.listFunnels();
    const filtered = state.search
      ? funnels.filter((f) => f.name.toLowerCase().includes(state.search.toLowerCase()))
      : funnels;
    renderFunnelList(grid, filtered);
    return;
  }

  const types = FILTER_TYPES[state.filter];
  const all = [];
  for (const type of types) {
    const items = await storage.listItems({ type, search: state.search || undefined });
    all.push(...items);
  }
  all.sort((a, b) => b.createdAt - a.createdAt);
  renderItemList(grid, all);
}

// ------------------------------------------------------------
// Dashboard (tab Tudo)
// ------------------------------------------------------------
async function renderDashboard(container) {
  const items = await storage.listItems();
  const funnels = await storage.listFunnels();

  const counts = {
    text: items.filter((i) => i.type === 'text').length,
    audio: items.filter((i) => i.type === 'audio').length,
    media: items.filter((i) => i.type === 'image' || i.type === 'video').length,
    file: items.filter((i) => i.type === 'file').length,
    funnel: funnels.length,
  };

  // Nome do usuário (auth state)
  let userName = 'por aqui';
  try {
    const stored = await chrome.storage.local.get('zf_auth_state');
    const label = stored?.zf_auth_state?.label;
    if (label) userName = label;
  } catch (_) {}

  container.classList.add('dashboard-grid');
  container.innerHTML = `
    <div class="dashboard-welcome">
      <h1>Bem-vindo de volta, ${escapeHTML(userName)} 👋</h1>
      <p>Total de itens cadastrados</p>
    </div>

    <div class="stats-grid">
      ${statCardHTML('funnel', 'Funis', counts.funnel, 'funnels')}
      ${statCardHTML('text',   'Mensagens', counts.text, 'text')}
      ${statCardHTML('audio',  'Áudios', counts.audio, 'audio')}
      ${statCardHTML('media',  'Mídias', counts.media, 'image')}
      ${statCardHTML('file',   'Documentos', counts.file, 'file')}
    </div>
  `;

  // Clicks em cards → navega pro filtro respectivo
  container.querySelectorAll('.stat-card').forEach((btn) => {
    btn.addEventListener('click', () => setActiveFilter(btn.dataset.target));
  });
}

function statCardHTML(colorKey, label, count, targetFilter) {
  const icons = {
    funnel: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
    text:   '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    audio:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    media:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    file:   '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
  };
  return `
    <button class="stat-card stat-card--${colorKey}" data-target="${targetFilter}">
      <span class="stat-icon">${icons[colorKey] || ''}</span>
      <div class="stat-body">
        <span class="stat-label">${label}</span>
        <span class="stat-count">${count}</span>
      </div>
    </button>
  `;
}

// ------------------------------------------------------------
// List view (tabs específicas)
// ------------------------------------------------------------
function renderItemList(container, items) {
  container.classList.remove('dashboard-grid');
  if (!items.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">+</div>
        <div class="empty-title">Nenhum item nessa categoria</div>
        <div>Use os botões acima pra adicionar.</div>
      </div>
    `;
    return;
  }
  container.innerHTML = '';
  for (const item of items) container.appendChild(itemRow(item));
}

function renderFunnelList(container, funnels) {
  container.classList.remove('dashboard-grid');
  if (!funnels.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">⟶</div>
        <div class="empty-title">Nenhum funil ainda</div>
        <div>Funis enviam vários items em sequência com delay entre eles.</div>
      </div>
    `;
    return;
  }
  container.innerHTML = '';
  for (const funnel of funnels) container.appendChild(funnelRow(funnel));
}

function itemRow(item) {
  const colorKey = typeColorKey(item.type);
  const row = document.createElement('div');
  row.className = `list-row list-row--${colorKey}`;
  row.dataset.id = item.id;
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/zf-item-id', item.id);
    e.dataTransfer.effectAllowed = 'copy';
  });
  row.onclick = () => openItemModal(item);

  row.innerHTML = `
    <span class="list-badge list-badge--${colorKey}">${badgeFor(item.type)}</span>
    <span class="list-name">${escapeHTML(item.title || '(sem título)')}</span>
    <span class="list-meta">${rowMeta(item)}</span>
  `;
  return row;
}

function funnelRow(funnel) {
  const row = document.createElement('div');
  row.className = 'list-row list-row--funnel';
  row.onclick = () => openFunnelModal(funnel);
  row.innerHTML = `
    <span class="list-badge list-badge--funnel">FUNIL</span>
    <span class="list-name">${escapeHTML(funnel.name || '(sem nome)')}</span>
    <span class="list-meta">${funnel.steps.length} step(s)</span>
  `;
  return row;
}

function rowMeta(item) {
  const parts = [];
  if (item.uses) parts.push(`${item.uses} envios`);
  if (item.size) parts.push(formatSize(item.size));
  if (item.duration) parts.push(formatDuration(item.duration));
  return parts.join(' • ');
}

function metaSpan(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

// ============================================================
// MODAL DE ITEM (criar/editar)
// ============================================================

function openItemModal(itemOrType) {
  const isEdit = itemOrType && typeof itemOrType === 'object' && itemOrType.id;
  const draft = isEdit
    ? { ...itemOrType }
    : { type: itemOrType, title: '', content: null, tags: [], folder: '', caption: '' };

  state.draftItem = draft;

  const label = TYPE_LABELS[draft.type] || 'item';
  const article = TYPE_GENDER[draft.type] === 'f' ? 'Nova' : 'Novo';
  $('modal-item-title').textContent = isEdit ? `Editar ${label}` : `${article} ${label}`;

  $('item-title').value = draft.title || '';
  $('item-caption').value = draft.caption || '';

  // Mostra/esconde campos por tipo
  $('field-text').hidden = draft.type !== 'text';
  $('field-file').hidden = draft.type === 'text';
  $('field-caption').hidden = draft.type === 'text' || draft.type === 'audio';

  if (draft.type === 'text') {
    $('item-content-text').value = draft.content || '';
  } else {
    refreshFilePreview();
  }

  // Botão de excluir só faz sentido em edição
  $('btn-delete-item').hidden = !isEdit;

  // Reset do file input pra evitar reusar arquivo anterior
  $('item-file').value = '';

  $('modal-item').showModal();
  $('item-title').focus();
}

function refreshFilePreview() {
  const draft = state.draftItem;
  const info = $('file-info');
  const wave = $('waveform');
  const preview = $('media-preview');

  preview.innerHTML = '';
  wave.hidden = true;

  if (!draft.content) {
    info.hidden = true;
    return;
  }

  const sizeStr = draft.size ? formatSize(draft.size) : '';
  const durStr = draft.duration ? formatDuration(draft.duration) : '';
  const parts = [draft.mimeType || draft.type, sizeStr, durStr].filter(Boolean);
  info.textContent = parts.join(' • ');
  info.hidden = false;

  if (draft.type === 'image' && draft.content instanceof Blob) {
    const img = document.createElement('img');
    img.src = blobURL(draft.content);
    preview.appendChild(img);
  } else if (draft.type === 'video' && draft.content instanceof Blob) {
    const v = document.createElement('video');
    v.controls = true;
    v.src = blobURL(draft.content);
    preview.appendChild(v);
  } else if (draft.type === 'audio' && draft.content instanceof Blob) {
    const a = document.createElement('audio');
    a.controls = true;
    a.src = blobURL(draft.content);
    preview.appendChild(a);
    // Waveform
    wave.hidden = false;
    requestAnimationFrame(() => drawWaveform(draft.content, wave));
  }
}

async function handleFileSelected(file) {
  if (!file) return;
  const draft = state.draftItem;
  if (!draft) return;

  if (!draft.title) {
    $('item-title').value = file.name.replace(/\.[^.]+$/, '');
  }

  // Áudio: converte pra OGG/Opus REAL pra ter waveform correto no
  // PTT do WhatsApp. Usa opus-media-recorder (polyfill WASM) — o
  // MediaRecorder nativo do Chrome só produz WebM (WA rejeita).
  if (draft.type === 'audio' && !isOggOpus(file)) {
    toast('Convertendo áudio pra OGG Opus...', 'info');
    try {
      const opus = await convertToOggOpus(file);
      draft.content = opus;
      draft.mimeType = opus.type;
      draft.size = opus.size;
      draft.duration = await getMediaDuration(opus, 'audio');
      toast(`Convertido — ${formatSize(opus.size)}`, 'success');
    } catch (e) {
      console.warn('Conversão OGG falhou:', e);
      toast('Conversão falhou, salvando original (waveform simples)', 'warning');
      draft.content = file;
      draft.mimeType = file.type;
      draft.size = file.size;
      draft.duration = await getMediaDuration(file, 'audio');
    }
  } else {
    draft.content = file;
    draft.mimeType = file.type;
    draft.size = file.size;

    if (draft.type === 'audio' || draft.type === 'video') {
      draft.duration = await getMediaDuration(file, draft.type);
    }
    if (draft.type === 'video') {
      draft.thumbnail = await generateVideoThumbnail(file);
    }
    if (draft.type === 'image') {
      draft.thumbnail = file;
    }
  }

  refreshFilePreview();
}

// ------------------------------------------------------------
// Conversão pra OGG Opus (WA PTT format)
// ------------------------------------------------------------
// Usa opus-media-recorder (UMD carregado no manager.html) que é
// um polyfill de MediaRecorder com saída OGG real. Tempo de
// conversão ≈ duração do áudio (playback realtime).
// ------------------------------------------------------------
function isOggOpus(blob) {
  const t = (blob.type || '').toLowerCase();
  return t.includes('ogg') && t.includes('opus');
}

async function convertToOggOpus(blob) {
  if (typeof OpusMediaRecorder === 'undefined') {
    throw new Error('OpusMediaRecorder não carregado (verifica vendor/opus/)');
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('AudioContext indisponível');

  const ctx = new AC();
  const arrayBuf = await blob.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);

  // MediaStream sem output de áudio (não toca no speaker)
  const dest = ctx.createMediaStreamDestination();
  const source = ctx.createBufferSource();
  source.buffer = audioBuf;
  source.connect(dest);

  // Worker + WASM paths via chrome.runtime.getURL (extension origin)
  const workerOptions = {
    encoderWorkerFactory: () => new Worker(chrome.runtime.getURL('vendor/opus/encoderWorker.umd.js')),
    OggOpusEncoderWasmPath: chrome.runtime.getURL('vendor/opus/OggOpusEncoder.wasm'),
    WebMOpusEncoderWasmPath: chrome.runtime.getURL('vendor/opus/WebMOpusEncoder.wasm'),
  };

  const recorder = new OpusMediaRecorder(
    dest.stream,
    { mimeType: 'audio/ogg;codecs=opus', audioBitsPerSecond: 32000 },
    workerOptions
  );

  const chunks = [];

  return new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onerror = (e) => reject(e.error || new Error('recorder error'));
    recorder.onstop = () => {
      try { ctx.close(); } catch (_) {}
      if (!chunks.length) return reject(new Error('sem chunks'));
      resolve(new Blob(chunks, { type: 'audio/ogg;codecs=opus' }));
    };

    source.onended = () => {
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 200);
    };

    recorder.start();
    source.start();
  });
}

async function saveItemFromModal(event) {
  event.preventDefault();
  const draft = state.draftItem;
  if (!draft) return;

  const title = $('item-title').value.trim();
  if (!title) {
    toast('Título obrigatório', 'warning');
    return;
  }

  draft.title = title;

  if (draft.type === 'text') {
    const txt = $('item-content-text').value;
    if (!txt.trim()) {
      toast('Conteúdo obrigatório', 'warning');
      return;
    }
    draft.content = txt;
    draft.size = txt.length;
  } else {
    if (!(draft.content instanceof Blob)) {
      toast('Selecione um arquivo', 'warning');
      return;
    }
    draft.caption = $('item-caption').value.trim() || null;
  }

  try {
    if (draft.id) {
      await storage.updateItem(draft.id, draft);
      toast('Atualizado', 'success');
    } else {
      await storage.addItem(draft);
      toast('Criado', 'success');
    }
    $('modal-item').close();
    state.draftItem = null;
    renderList();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  }
}

async function confirmDeleteItem(item) {
  if (!confirm(`Excluir "${item.title}"?`)) return;
  await storage.deleteItem(item.id);
  toast('Excluído', 'success');
  renderList();
}

// ============================================================
// MODAL DE FUNIL (criar/editar)
// ============================================================

async function openFunnelModal(funnel) {
  const isEdit = !!(funnel && funnel.id);
  state.draftFunnel = isEdit
    ? { ...funnel, steps: funnel.steps.map((s) => ({ ...s })) }
    : { name: '', steps: [] };

  $('modal-funnel-title').textContent = isEdit ? 'Editar funil' : 'Novo funil';
  $('funnel-name').value = state.draftFunnel.name;
  $('btn-delete-funnel').hidden = !isEdit;

  // Cache de items pra referência ao renderizar steps
  state.poolItems = await storage.listItems();
  renderFunnelSteps();

  $('modal-funnel').showModal();
  $('funnel-name').focus();
}

function renderFunnelSteps() {
  const list = $('funnel-steps');
  const empty = $('funnel-empty');
  const draft = state.draftFunnel;
  list.innerHTML = '';

  if (!draft.steps.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i];
    const item = state.poolItems.find((it) => it.id === step.itemId);
    const title = item ? item.title : '(item removido)';
    const type = item ? item.type : 'funnel';
    const colorKey = typeColorKey(type);
    const delaySec = Math.round(step.delayMs / 1000);
    const delayLabel =
      delaySec === 0 ? 'imediato' :
      delaySec < 60 ? `${delaySec}s` :
      `${Math.floor(delaySec / 60)}min ${delaySec % 60}s`;

    const row = document.createElement('div');
    row.className = `step-row step-row--${colorKey}`;
    row.dataset.index = i;
    row.draggable = true;

    row.innerHTML = `
      <span class="step-handle" title="Arrastar pra reordenar">≡</span>
      <span class="step-order">${i + 1}</span>
      <span class="list-badge list-badge--${colorKey}">${badgeFor(type) || type.toUpperCase()}</span>
      <span class="step-name">${escapeHTML(title)}</span>
      <span class="step-delay-label">${delayLabel}</span>
      <button type="button" class="step-remove" title="Remover">×</button>
    `;

    // Click em qualquer parte que não seja handle ou remover → editar
    row.addEventListener('click', (e) => {
      if (e.target.closest('.step-handle') || e.target.closest('.step-remove')) return;
      openStepModal(i);
    });

    row.querySelector('.step-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      draft.steps.splice(i, 1);
      renderFunnelSteps();
    });

    // Reordenar via drag-and-drop
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/zf-step-index', String(i));
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/zf-step-index')) {
        e.preventDefault();
        row.classList.add('step-dragover');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('step-dragover'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('step-dragover');
      const fromIdx = parseInt(e.dataTransfer.getData('text/zf-step-index'), 10);
      if (isNaN(fromIdx) || fromIdx === i) return;
      e.preventDefault();
      const [moved] = draft.steps.splice(fromIdx, 1);
      draft.steps.splice(i, 0, moved);
      renderFunnelSteps();
    });

    list.appendChild(row);
  }
}

// ============================================================
// MODAL DE STEP (adicionar/editar item no funil)
// ============================================================

function openStepModal(stepIndex = null) {
  const editing = stepIndex !== null;
  const step = editing
    ? state.draftFunnel.steps[stepIndex]
    : { itemId: '', delayMs: 0 };
  state.stepEditIndex = editing ? stepIndex : null;

  $('modal-step-title').textContent = editing ? 'Editar item' : 'Adicionar item';

  // Decide tab inicial baseado no item existente
  let activeTab = 'text';
  if (editing && step.itemId) {
    const item = state.poolItems.find((i) => i.id === step.itemId);
    if (item) activeTab = typeToStepTab(item.type);
  }

  setStepItemValue(editing ? step.itemId : '');
  setStepTab(activeTab);
  closeStepPanel();

  const mins = Math.floor(step.delayMs / 60000);
  const secs = Math.floor((step.delayMs % 60000) / 1000);
  $('step-delay-min').value = mins;
  $('step-delay-sec').value = secs;

  $('modal-step').showModal();
}

function typeToStepTab(type) {
  if (type === 'text') return 'text';
  if (type === 'audio') return 'audio';
  if (type === 'image' || type === 'video') return 'media';
  if (type === 'file') return 'file';
  return 'text';
}

function setStepTab(tab) {
  state.currentStepTab = tab;
  document.querySelectorAll('.step-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.stepTab === tab);
  });

  // Se o item selecionado não pertence mais à nova tab, limpa seleção
  const currentId = $('step-item').value;
  if (currentId) {
    const curItem = state.poolItems.find((i) => i.id === currentId);
    if (curItem && typeToStepTab(curItem.type) !== tab) {
      setStepItemValue('');
    }
  }

  renderStepList();
}

// ------------------------------------------------------------
// Custom select pra picker de item (com busca)
// ------------------------------------------------------------
function setStepItemValue(itemId) {
  $('step-item').value = itemId;
  const label = $('cs-label');
  const item = itemId ? state.poolItems.find((i) => i.id === itemId) : null;
  if (item) {
    label.textContent = item.title;
    label.classList.remove('cs-label--placeholder');
  } else {
    label.textContent = 'Selecione um item';
    label.classList.add('cs-label--placeholder');
  }
}

function toggleStepPanel(force) {
  const panel = $('cs-panel');
  const show = typeof force === 'boolean' ? force : panel.hidden;
  panel.hidden = !show;
  $('cs-trigger').setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) {
    $('cs-search').value = '';
    renderStepList();
    positionStepPanel();
    setTimeout(() => $('cs-search').focus(), 30);
  }
}

// Posiciona o panel em coordenadas fixed, alinhado com o trigger.
// Evita ser clipado pelo overflow:auto do modal-body.
function positionStepPanel() {
  const trigger = $('cs-trigger');
  const panel = $('cs-panel');
  const rect = trigger.getBoundingClientRect();

  // Calcula altura disponível abaixo do trigger e limita o panel
  const viewportH = window.innerHeight;
  const spaceBelow = viewportH - rect.bottom - 16;
  const spaceAbove = rect.top - 16;
  const preferBelow = spaceBelow >= 220 || spaceBelow >= spaceAbove;

  const maxH = Math.max(180, Math.min(360, preferBelow ? spaceBelow : spaceAbove));

  panel.style.left = `${rect.left}px`;
  panel.style.width = `${rect.width}px`;
  panel.style.maxHeight = `${maxH}px`;

  if (preferBelow) {
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.bottom = 'auto';
  } else {
    panel.style.top = 'auto';
    panel.style.bottom = `${viewportH - rect.top + 4}px`;
  }
}

function closeStepPanel() {
  toggleStepPanel(false);
}

function renderStepList() {
  const tab = state.currentStepTab || 'text';
  const query = ($('cs-search').value || '').toLowerCase().trim();

  const filtered = state.poolItems.filter((i) => {
    const typeMatch =
      tab === 'text' ? i.type === 'text' :
      tab === 'audio' ? i.type === 'audio' :
      tab === 'media' ? (i.type === 'image' || i.type === 'video') :
      tab === 'file' ? i.type === 'file' : false;
    if (!typeMatch) return false;
    if (!query) return true;
    return (i.title || '').toLowerCase().includes(query);
  });

  const list = $('cs-list');
  list.innerHTML = '';

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'cs-empty';
    empty.textContent = query ? 'Nenhum item bate com a busca.' : 'Nenhum item nessa categoria.';
    list.appendChild(empty);
    return;
  }

  const currentId = $('step-item').value;
  for (const item of filtered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cs-item' + (item.id === currentId ? ' cs-item--active' : '');
    row.innerHTML = `
      <span class="list-badge list-badge--${typeColorKey(item.type)}">${badgeFor(item.type)}</span>
      <span class="cs-item-name">${escapeHTML(item.title)}</span>
    `;
    row.addEventListener('click', () => {
      setStepItemValue(item.id);
      closeStepPanel();
    });
    list.appendChild(row);
  }
}

async function saveStepFromModal(event) {
  event.preventDefault();
  const itemId = $('step-item').value;
  if (!itemId) {
    toast('Selecione um item', 'warning');
    return;
  }
  const mins = Math.max(0, parseInt($('step-delay-min').value, 10) || 0);
  const secs = Math.max(0, parseInt($('step-delay-sec').value, 10) || 0);
  const delayMs = (mins * 60 + secs) * 1000;

  if (state.stepEditIndex !== null) {
    state.draftFunnel.steps[state.stepEditIndex] = { itemId, delayMs };
  } else {
    state.draftFunnel.steps.push({ itemId, delayMs });
  }

  $('modal-step').close();
  state.stepEditIndex = null;
  renderFunnelSteps();
}

async function saveFunnelFromModal(event) {
  event.preventDefault();
  const draft = state.draftFunnel;
  if (!draft) return;

  const name = $('funnel-name').value.trim();
  if (!name) { toast('Nome obrigatório', 'warning'); return; }
  if (!draft.steps.length) { toast('Adicione pelo menos um step', 'warning'); return; }

  draft.name = name;

  try {
    if (draft.id) {
      await storage.updateFunnel(draft.id, draft);
      toast('Funil atualizado', 'success');
    } else {
      await storage.addFunnel(draft);
      toast('Funil criado', 'success');
    }
    $('modal-funnel').close();
    state.draftFunnel = null;
    renderList();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  }
}

async function confirmDeleteFunnel(funnel) {
  if (!confirm(`Excluir o funil "${funnel.name}"?`)) return;
  await storage.deleteFunnel(funnel.id);
  toast('Funil excluído', 'success');
  renderList();
}

// ============================================================
// EXPORT / IMPORT
// ============================================================

async function doExport() {
  try {
    const dump = await storage.exportAll();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zapfire-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup exportado', 'success');
  } catch (err) {
    toast('Erro no export: ' + err.message, 'error');
  }
}

async function doImport(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await storage.importAll(data);
    toast(`${result.importedItems} itens, ${result.importedFunnels} funis importados`, 'success');
    renderList();
  } catch (err) {
    toast('Erro no import: ' + err.message, 'error');
  }
}

// ============================================================
// UTILS
// ============================================================
function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ============================================================
// BOOTSTRAP
// ============================================================

function setActiveFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filter-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  updateCreateButton();
  renderList();
}

// Rótulo e visibilidade do botão "+ Novo" conforme aba ativa
function updateCreateButton() {
  const btn = $('btn-create');
  const labels = {
    all: null, // oculto
    funnels: '+ Novo funil',
    text: '+ Nova mensagem',
    audio: '+ Novo áudio',
    image: '+ Nova imagem',
    video: '+ Novo vídeo',
    file: '+ Novo arquivo',
  };
  const label = labels[state.filter];
  if (!label) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = label;
}

function init() {
  // Filtros
  document.querySelectorAll('.filter-item').forEach((btn) => {
    btn.addEventListener('click', () => setActiveFilter(btn.dataset.filter));
  });

  // Busca
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderList();
  });

  // Botão "+ Novo" contextual — muda conforme a aba ativa
  $('btn-create').addEventListener('click', () => {
    const f = state.filter;
    if (f === 'funnels') openFunnelModal(null);
    else if (f === 'text' || f === 'audio' || f === 'image' || f === 'video' || f === 'file') {
      openItemModal(f);
    }
    // Em "Tudo" o botão fica oculto — nenhum tipo implícito
  });

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.close;
      $(id).close();
      if (id === 'modal-item') state.draftItem = null;
      if (id === 'modal-funnel') state.draftFunnel = null;
    });
  });

  // Form do item
  $('form-item').addEventListener('submit', saveItemFromModal);
  $('btn-delete-item').addEventListener('click', async () => {
    if (state.draftItem && state.draftItem.id) {
      await confirmDeleteItem(state.draftItem);
      $('modal-item').close();
      state.draftItem = null;
    }
  });

  // Form do funil
  $('form-funnel').addEventListener('submit', saveFunnelFromModal);
  $('btn-delete-funnel').addEventListener('click', async () => {
    if (state.draftFunnel && state.draftFunnel.id) {
      await confirmDeleteFunnel(state.draftFunnel);
      $('modal-funnel').close();
      state.draftFunnel = null;
    }
  });
  // Adicionar step (abre sub-modal)
  $('btn-add-step').addEventListener('click', () => openStepModal(null));

  // Form de step
  $('form-step').addEventListener('submit', saveStepFromModal);
  document.querySelectorAll('.step-tab').forEach((tab) => {
    tab.addEventListener('click', () => setStepTab(tab.dataset.stepTab));
  });

  // Custom select do item (trigger + panel + busca)
  $('cs-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStepPanel();
  });
  $('cs-search').addEventListener('input', () => renderStepList());

  // Fecha panel ao clicar fora dele
  document.addEventListener('click', (e) => {
    if (!$('cs-panel').hidden &&
        !$('cs-panel').contains(e.target) &&
        !$('cs-trigger').contains(e.target)) {
      closeStepPanel();
    }
  });

  // Reposiciona panel em resize/scroll (posição fixed precisa recalcular)
  window.addEventListener('resize', () => {
    if (!$('cs-panel').hidden) positionStepPanel();
  });
  $('modal-step').addEventListener('scroll', () => {
    if (!$('cs-panel').hidden) positionStepPanel();
  }, true);

  // Dropzone do file picker
  const dz = $('dropzone');
  dz.addEventListener('click', () => $('item-file').click());
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
  });
  $('item-file').addEventListener('change', (e) => {
    if (e.target.files[0]) handleFileSelected(e.target.files[0]);
  });

  // Export/Import
  $('btn-export').addEventListener('click', doExport);
  $('btn-import').addEventListener('click', () => $('import-file').click());

  // Abrir painel do assinante em nova aba (URL vem de config.js — build-replaced)
  $('btn-panel').addEventListener('click', () => {
    window.open(`${PANEL_URL}/dashboard`, '_blank', 'noopener,noreferrer');
  });
  $('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) doImport(e.target.files[0]);
  });

  // Hash navigation: #edit=ITEM_ID ou #funnel=FUNNEL_ID
  handleHashFocus();
  window.addEventListener('hashchange', handleHashFocus);

  renderList();
}

async function handleHashFocus() {
  const hash = window.location.hash.replace('#', '');
  if (!hash) return;

  if (hash.startsWith('edit=')) {
    const id = hash.slice(5);
    const item = await storage.getItem(id);
    if (item) openItemModal(item);
  } else if (hash.startsWith('funnel=')) {
    const id = hash.slice(7);
    const funnel = await storage.getFunnel(id);
    if (funnel) openFunnelModal(funnel);
  } else if (hash === 'funnels') {
    setActiveFilter('funnels');
  }
}

init();
