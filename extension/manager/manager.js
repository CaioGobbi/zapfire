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
import * as backup from '../lib/backup.js';
import { reconcileOrphanRuns } from '../lib/funnel-tracker.js';
import { generateReportText, groupRunsByFunnel } from '../lib/report-template.js';
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
  // Modal de backup
  backupFile: null,        // File atualmente selecionado pra import
  backupPreview: null,     // Resultado de previewBackup() pro file atual
  // Sprint 5 — features do plano (espelho do zf_plan_features no chrome.storage)
  // Default {} = Free (todos os checks `!!features.tracking` viram false).
  planFeatures: {},
  // Sprint 5 — filtros da tab Relatórios
  reportsPeriod: 'today',   // 'today' | '7d' | '30d'
  reportsFunnelId: 'all',   // 'all' | <funnelId>
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
// Confirmação custom — substitui window.confirm nativo. Retorna
// Promise<boolean>. Aceita texto multi-linha via opts.body (string,
// linhas separadas por \n) ou opts.bodyHtml (controle total).
//
// Observação: escutamos `cancel` (ESC) em vez de `close` pra evitar
// que o evento close (que pode disparar async em algumas versões
// do Chrome) seja capturado pelo listener da próxima invocação
// quando o mesmo dialog é reutilizado em sequência (caso "double
// confirm" como o Apagar TUDO).
function confirmModal(opts = {}) {
  const title = opts.title || 'Confirmar?';
  const confirmLabel = opts.confirmLabel || 'Confirmar';
  const cancelLabel = opts.cancelLabel || 'Cancelar';

  return new Promise((resolve) => {
    const d = $('modal-confirm');
    $('confirm-title').textContent = title;

    const bodyEl = $('confirm-body');
    bodyEl.innerHTML = '';
    if (opts.bodyHtml) {
      bodyEl.innerHTML = opts.bodyHtml;
    } else if (opts.body) {
      // Cada \n vira uma linha. textContent escapa HTML automático.
      const lines = String(opts.body).split('\n');
      for (const line of lines) {
        const p = document.createElement('p');
        p.textContent = line;
        if (!line.trim()) p.style.height = '6px';
        bodyEl.appendChild(p);
      }
    }

    const okBtn = $('confirm-ok');
    const cancelBtn = $('confirm-cancel');
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      d.removeEventListener('cancel', onEsc);
      try { d.close(); } catch (_) {}
      resolve(value);
    };
    const onOk = () => settle(true);
    const onCancel = () => settle(false);
    // ESC: previne o close default pra não disparar event close
    // assíncrono e fechamos via settle. Comportamento idêntico do user.
    const onEsc = (e) => { e.preventDefault(); settle(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    d.addEventListener('cancel', onEsc);

    d.showModal();
  });
}

let toastTimer = null;
function toast(message, type = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast ' + type;
  // Popover API: top-layer (acima de qualquer dialog aberto). Se já
  // tava aberto, fecha primeiro pra evitar InvalidStateError.
  try { el.hidePopover(); } catch (_) {}
  try { el.showPopover(); } catch (_) {}
  if (toastTimer) clearTimeout(toastTimer);
  // Toasts de sucesso ficam mais tempo — usuário precisa enxergar
  const duration = type === 'success' ? 4200 : 2800;
  toastTimer = setTimeout(() => {
    try { el.hidePopover(); } catch (_) {}
  }, duration);
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

  // Sprint 5 — Tab Relatórios
  if (state.filter === 'reports') {
    await renderReports(grid);
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

  // Sprint 5 — card de Funis Monitorados (Hoje)
  const monitoredFunnels = funnels.filter((f) => f.trackingEnabled);
  const isPro = !!state.planFeatures.tracking;
  const todayRange = periodToRange('today');
  const todayRuns = await storage.listRuns({
    status: 'completed',
    since: todayRange.since,
    until: todayRange.until,
  });
  const monitoringCardHtml = renderMonitoringCardHTML({
    monitoredFunnels,
    todayRuns,
    isPro,
  });

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

    ${monitoringCardHtml}
  `;

  // Clicks em cards → navega pro filtro respectivo
  container.querySelectorAll('.stat-card').forEach((btn) => {
    btn.addEventListener('click', () => setActiveFilter(btn.dataset.target));
  });

  // Sprint 5 — wires do monitoring card
  const seeAllBtn = container.querySelector('[data-action="see-reports"]');
  if (seeAllBtn) seeAllBtn.addEventListener('click', () => setActiveFilter('reports'));
  const ctaBtn = container.querySelector('[data-action="enable-tracking-cta"]');
  if (ctaBtn) ctaBtn.addEventListener('click', () => setActiveFilter('funnels'));
  const upgradeBtn = container.querySelector('[data-action="upgrade-pro"]');
  if (upgradeBtn) upgradeBtn.addEventListener('click', () => openUpgradeProModal());
}

// Sprint 5 — Card "Funis Monitorados (Hoje)" no dashboard.
// 3 estados: Free (preview com badge Pro), Pro sem tracking ativo
// (CTA pra ativar), Pro com tracking ativo (lista contagens).
function renderMonitoringCardHTML({ monitoredFunnels, todayRuns, isPro }) {
  const headerSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>';

  // Estado 1: Free → preview bloqueado com badge Pro
  if (!isPro) {
    return `
      <div class="monitoring-card monitoring-card--locked">
        <div class="monitoring-header">
          <span class="monitoring-icon">${headerSvg}</span>
          <span class="monitoring-title">Funis Monitorados</span>
          <span class="tracking-pro-badge">Pro</span>
        </div>
        <p class="monitoring-empty">
          Acompanhe quais leads chegaram ao final dos seus funis e receba relatórios
          diários no seu próprio WhatsApp.
        </p>
        <button class="btn-primary" data-action="upgrade-pro">Conhecer o plano Pro</button>
      </div>
    `;
  }

  // Estado 2: Pro mas nenhum funil tem tracking ativo
  if (monitoredFunnels.length === 0) {
    return `
      <div class="monitoring-card">
        <div class="monitoring-header">
          <span class="monitoring-icon">${headerSvg}</span>
          <span class="monitoring-title">Funis Monitorados</span>
        </div>
        <p class="monitoring-empty">
          Nenhum funil com acompanhamento ativo ainda.
        </p>
        <button class="btn-ghost" data-action="enable-tracking-cta">
          Ativar acompanhamento num funil →
        </button>
      </div>
    `;
  }

  // Estado 3: Pro com funis monitorados — agrupa runs do dia por funnelId
  const countsByFunnel = new Map();
  for (const run of todayRuns) {
    countsByFunnel.set(run.funnelId, (countsByFunnel.get(run.funnelId) || 0) + 1);
  }
  const total = todayRuns.length;
  // Mostra TODOS os funis monitorados (mesmo com 0 hoje), ordenados
  // por quantidade desc — assim o user vê quais estão "vivos".
  const rows = monitoredFunnels
    .map((f) => ({
      name: f.trackingLabel || f.name,
      count: countsByFunnel.get(f.id) || 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Barra visual: máximo entre todas as contagens (escala relativa)
  const maxCount = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;

  const rowsHtml = rows.map((r) => {
    const barWidth = Math.round((r.count / maxCount) * 100);
    return `
      <div class="monitoring-row">
        <span class="monitoring-row-name">${escapeHTML(r.name)}</span>
        <div class="monitoring-row-bar">
          <div class="monitoring-row-fill" style="width: ${barWidth}%"></div>
        </div>
        <span class="monitoring-row-count">${r.count}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="monitoring-card">
      <div class="monitoring-header">
        <span class="monitoring-icon">${headerSvg}</span>
        <span class="monitoring-title">Funis Monitorados (Hoje)</span>
      </div>
      <div class="monitoring-rows">
        ${rowsHtml}
      </div>
      <div class="monitoring-footer">
        <strong>Total: ${total} ${total === 1 ? 'lead completou um funil hoje' : 'leads completaram funis hoje'}</strong>
        <button class="btn-ghost" data-action="see-reports">Ver relatório completo →</button>
      </div>
    </div>
  `;
}

// ============================================================
// Sprint 5 — Tab "Relatórios"
// ============================================================

// Converte período do filtro em { since, until } em ms.
// 'today' = de 00:00 do dia local até agora.
// '7d'   = últimas 168h (rolling).
// '30d'  = últimas 720h (rolling).
function periodToRange(period) {
  const now = Date.now();
  if (period === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { since: start.getTime(), until: now };
  }
  if (period === '7d') return { since: now - 7 * 86400_000, until: now };
  if (period === '30d') return { since: now - 30 * 86400_000, until: now };
  return { since: 0, until: now };
}

const PERIOD_LABELS = {
  today: 'Hoje',
  '7d':  'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
};

function formatRunTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// generateReportText e groupRunsByFunnel vêm de lib/report-template.js
// (compartilhados com service-worker e funnel-tracker — Sprint 5 ETAPA C)

// Manda mensagem pra primeira aba do WA Web.
// Retorna { ok, error?, noTab? } pra UI mostrar mensagem certa.
async function callWAWebTab(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (!tabs || tabs.length === 0) {
      return { ok: false, noTab: true, error: 'Abra o WhatsApp Web primeiro' };
    }
    const tab = tabs[0];
    const result = await chrome.tabs.sendMessage(tab.id, message);
    return result || { ok: false, error: 'Sem resposta do content script' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// "Abrir conversa" — foca a tab do WA Web e abre o chat do JID.
async function openChatViaWAWeb(jid, name) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (!tabs || tabs.length === 0) {
      toast('Abra o WhatsApp Web primeiro', 'warning');
      return;
    }
    const tab = tabs[0];
    // Foca a aba + janela ANTES de mandar a mensagem
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    }
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'ZF_OPEN_CHAT_FROM_MANAGER',
      jid,
      name,
    });
    if (!result?.ok) {
      toast('Não consegui abrir a conversa: ' + (result?.error || 'erro'), 'error');
    }
  } catch (err) {
    toast('Falha ao abrir conversa: ' + (err.message || err), 'error');
  }
}

async function renderReports(container) {
  container.classList.remove('dashboard-grid');
  const isPro = !!state.planFeatures.tracking;

  // Free: tela bloqueada com badge Pro
  if (!isPro) {
    container.innerHTML = `
      <div class="reports-locked">
        <div class="monitoring-icon" style="margin-bottom: 16px; color: var(--type-funnel);">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
        </div>
        <h2 style="margin-bottom: 8px;">Relatórios — disponível no Pro</h2>
        <p style="color: var(--text-dim); max-width: 520px; margin: 0 auto 20px;">
          Acompanhe quais leads chegaram ao final dos funis monitorados, filtre por
          período e funil, e receba relatórios diários no seu próprio WhatsApp.
        </p>
        <button class="btn-primary" id="btn-reports-upgrade">Conhecer o plano Pro</button>
      </div>
    `;
    container.querySelector('#btn-reports-upgrade').addEventListener('click', openUpgradeProModal);
    return;
  }

  const funnels = await storage.listFunnels();
  const monitoredFunnels = funnels.filter((f) => f.trackingEnabled);

  const range = periodToRange(state.reportsPeriod);
  const filters = {
    status: 'completed',
    since: range.since,
    until: range.until,
  };
  if (state.reportsFunnelId !== 'all') filters.funnelId = state.reportsFunnelId;

  const runs = await storage.listRuns(filters);

  // Agrupa por funnelId mantendo ordem dos monitoredFunnels (que vem por createdAt DESC).
  const runsByFunnel = monitoredFunnels.map((f) => ({
    funnelId: f.id,
    name: f.trackingLabel || f.name,
    runs: runs.filter((r) => r.funnelId === f.id),
  }));

  // Funis que não estão mais ativos mas têm runs (ex: funil deletado depois)
  const activeIds = new Set(monitoredFunnels.map((f) => f.id));
  const orphanGroups = new Map();
  for (const r of runs) {
    if (!activeIds.has(r.funnelId)) {
      const key = r.funnelId;
      if (!orphanGroups.has(key)) {
        orphanGroups.set(key, { funnelId: key, name: r.funnelName + ' (apagado)', runs: [] });
      }
      orphanGroups.get(key).runs.push(r);
    }
  }
  for (const group of orphanGroups.values()) runsByFunnel.push(group);

  const groupsHtml = runsByFunnel.map(renderRunsGroup).join('');
  const emptyHtml = runs.length === 0
    ? `<div class="reports-empty">Nenhum lead completou funis monitorados nesse período.</div>`
    : '';

  const funnelOptions = ['<option value="all">Todos os funis</option>']
    .concat(monitoredFunnels.map((f) =>
      `<option value="${escapeHTML(f.id)}" ${state.reportsFunnelId === f.id ? 'selected' : ''}>${escapeHTML(f.trackingLabel || f.name)}</option>`
    )).join('');

  container.innerHTML = `
    <div class="reports">
      <header class="reports-header">
        <h2>Relatórios</h2>
        <p class="reports-sub">Funis com acompanhamento ativo — leads que chegaram ao final.</p>
      </header>

      <div class="reports-filters">
        <label class="reports-filter">
          <span>Período</span>
          <select id="reports-period">
            <option value="today" ${state.reportsPeriod === 'today' ? 'selected' : ''}>Hoje</option>
            <option value="7d"    ${state.reportsPeriod === '7d' ? 'selected' : ''}>Últimos 7 dias</option>
            <option value="30d"   ${state.reportsPeriod === '30d' ? 'selected' : ''}>Últimos 30 dias</option>
          </select>
        </label>
        <label class="reports-filter">
          <span>Funil</span>
          <select id="reports-funnel">${funnelOptions}</select>
        </label>
      </div>

      <div class="reports-list">
        ${groupsHtml}
        ${emptyHtml}
      </div>

      <footer class="reports-actions">
        <button class="btn-primary" id="btn-send-now">Enviar relatório agora pro meu WhatsApp</button>
        <button class="btn-ghost" id="btn-config-delivery">
          Configurar entrega automática
        </button>
      </footer>
    </div>
  `;

  // Wires dos filtros
  $('reports-period').addEventListener('change', (e) => {
    state.reportsPeriod = e.target.value;
    renderReports(container);
  });
  $('reports-funnel').addEventListener('change', (e) => {
    state.reportsFunnelId = e.target.value;
    renderReports(container);
  });

  // Click em "Abrir conversa" pra cada lead
  container.querySelectorAll('[data-action="open-chat"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const jid = btn.dataset.jid;
      const name = btn.dataset.name || '';
      openChatViaWAWeb(jid, name);
    });
  });

  // Click em "Configurar entrega automática"
  $('btn-config-delivery').addEventListener('click', () => {
    if (!state.planFeatures.dailyReport) {
      openUpgradeProModal();
      return;
    }
    openDeliveryConfigModal();
  });

  // Click em "Enviar agora"
  $('btn-send-now').addEventListener('click', async () => {
    if (runs.length === 0) {
      toast('Nada pra enviar — nenhum lead completou nesse período', 'warning');
      return;
    }
    const text = generateReportText(runsByFunnel, state.reportsPeriod);
    const btn = $('btn-send-now');
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = 'Enviando...';
    try {
      const result = await callWAWebTab({ type: 'ZF_SEND_REPORT_FROM_MANAGER', text });
      if (result.ok) {
        toast('Relatório enviado pro seu WhatsApp ✓', 'success');
      } else if (result.noTab) {
        toast('Abra o WhatsApp Web primeiro pra enviar o relatório', 'warning');
      } else {
        toast('Falha no envio: ' + (result.error || 'erro desconhecido'), 'error');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  });
}

// Render de um grupo (1 funil monitorado) na lista de Relatórios
function renderRunsGroup(group) {
  if (!group.runs.length) {
    return `
      <details class="reports-group">
        <summary>
          <span class="reports-group-name">${escapeHTML(group.name)}</span>
          <span class="reports-group-count">0</span>
        </summary>
        <div class="reports-group-empty">Sem leads neste período.</div>
      </details>
    `;
  }

  const leadsHtml = group.runs.map((r) => {
    const name = r.leadName || (r.leadJid?.split('@')[0]) || 'Sem nome';
    const time = formatRunTime(r.finishedAt || r.startedAt);
    return `
      <div class="reports-lead">
        <span class="reports-lead-name">${escapeHTML(name)}</span>
        <span class="reports-lead-time">${time}</span>
        <button class="btn-ghost reports-lead-open" data-action="open-chat"
                data-jid="${escapeHTML(r.leadJid)}" data-name="${escapeHTML(name)}">
          Abrir conversa
        </button>
      </div>
    `;
  }).join('');

  return `
    <details class="reports-group" open>
      <summary>
        <span class="reports-group-name">${escapeHTML(group.name)}</span>
        <span class="reports-group-count">${group.runs.length} ${group.runs.length === 1 ? 'lead' : 'leads'}</span>
      </summary>
      <div class="reports-leads">
        ${leadsHtml}
      </div>
    </details>
  `;
}

// ============================================================
// Sprint 5 ETAPA C — Modal "Configurar entrega automática"
// ============================================================

const DELIVERY_DEFAULT = {
  mode: 'disabled',
  fixedTime: '18:00',
  funnelIds: [],
  lastSentAt: null,
};

// Lê config salva em meta (canonical) — ou retorna defaults
async function loadDeliveryConfig() {
  const stored = await storage.getMeta('reports.delivery', null);
  return { ...DELIVERY_DEFAULT, ...(stored || {}) };
}

async function openDeliveryConfigModal() {
  const config = await loadDeliveryConfig();
  const allFunnels = await storage.listFunnels();
  const monitored = allFunnels.filter((f) => f.trackingEnabled);

  // Marca o modo correto
  document.querySelectorAll('input[name="delivery-mode"]').forEach((r) => {
    r.checked = r.value === config.mode;
  });
  $('delivery-fixed-time').value = config.fixedTime || '18:00';

  // Render dinâmico dos funis monitorados
  const list = $('delivery-funnels-list');
  if (monitored.length === 0) {
    list.innerHTML = `
      <div class="delivery-funnels-empty">
        Nenhum funil com acompanhamento ativo. Volte na tab Funis,
        edita um funil e marca "Acompanhar leads neste funil".
      </div>
    `;
  } else {
    list.innerHTML = monitored.map((f) => {
      const checked = config.funnelIds.includes(f.id) ? 'checked' : '';
      return `
        <label class="delivery-funnel-row">
          <input type="checkbox" value="${escapeHTML(f.id)}" ${checked} />
          <span>${escapeHTML(f.trackingLabel || f.name)}</span>
        </label>
      `;
    }).join('');
  }

  $('modal-delivery-config').showModal();
}

async function saveDeliveryConfigFromModal(event) {
  event.preventDefault();
  const mode = document.querySelector('input[name="delivery-mode"]:checked')?.value || 'disabled';
  const fixedTime = $('delivery-fixed-time').value || '18:00';
  const funnelIds = Array.from(
    document.querySelectorAll('#delivery-funnels-list input[type="checkbox"]:checked')
  ).map((cb) => cb.value);

  // Validações de UX
  if (mode !== 'disabled' && funnelIds.length === 0) {
    toast('Selecione pelo menos 1 funil pra incluir', 'warning');
    return;
  }
  if (mode === 'fixed' && !/^\d{2}:\d{2}$/.test(fixedTime)) {
    toast('Horário inválido', 'warning');
    return;
  }

  const previous = await loadDeliveryConfig();
  const config = {
    ...previous,
    mode,
    fixedTime,
    funnelIds,
  };

  // Salva em meta (canonical) — fonte da verdade pro manager
  await storage.setMeta('reports.delivery', config);

  // Espelha em chrome.storage.local pro service-worker ler rápido
  // sem precisar abrir IndexedDB. SW também usa pra reagendar alarms.
  try {
    await chrome.storage.local.set({ zf_reports_delivery: config });
  } catch (_) {}

  // Pede pro service-worker reagendar os alarms baseado na nova config
  try {
    await chrome.runtime.sendMessage({ type: 'ZF_RESCHEDULE_DELIVERY', config });
  } catch (err) {
    // SW pode estar dormindo — chrome.storage.onChanged também notifica,
    // então não é crítico se essa chamada falhar
    console.warn('[manager] ZF_RESCHEDULE_DELIVERY falhou:', err);
  }

  $('modal-delivery-config').close();
  const labels = { disabled: 'desativada', fixed: `horário fixo às ${fixedTime}`, immediate: 'imediato', every4h: 'a cada 4h' };
  toast(`Entrega automática salva: ${labels[mode] || mode}`, 'success');
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

  // Modo do drag: 'reorder' (handle) ou 'copy' (qualquer outra parte).
  // Existente: arrastar pro funil já manda 'text/zf-item-id'. Novo:
  // arrastar pelo handle ≡ entre rows reordena a lista.
  row.dataset.dragMode = 'copy';

  row.innerHTML = `
    <span class="list-handle" title="Arrastar pra reordenar">≡</span>
    <span class="list-badge list-badge--${colorKey}">${badgeFor(item.type)}</span>
    <span class="list-name">${escapeHTML(item.title || '(sem título)')}</span>
    <span class="list-meta">${rowMeta(item)}</span>
  `;

  const handle = row.querySelector('.list-handle');
  // mousedown define o modo do próximo dragstart.
  handle.addEventListener('mousedown', () => { row.dataset.dragMode = 'reorder'; });
  row.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.list-handle')) row.dataset.dragMode = 'copy';
  });

  row.addEventListener('dragstart', (e) => {
    if (row.dataset.dragMode === 'reorder') {
      e.dataTransfer.setData('text/zf-item-reorder-id', item.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('list-row--dragging');
    } else {
      e.dataTransfer.setData('text/zf-item-id', item.id);
      e.dataTransfer.effectAllowed = 'copy';
    }
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('list-row--dragging');
    row.classList.remove('list-row--dragover');
  });
  row.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/zf-item-reorder-id')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('list-row--dragover');
    }
  });
  row.addEventListener('dragleave', () => row.classList.remove('list-row--dragover'));
  row.addEventListener('drop', async (e) => {
    row.classList.remove('list-row--dragover');
    const draggedId = e.dataTransfer.getData('text/zf-item-reorder-id');
    if (!draggedId || draggedId === item.id) return;
    e.preventDefault();
    e.stopPropagation();

    // Pega a ordem atual do DOM, move o dragged pra antes desta row,
    // persiste e re-renderiza
    const container = row.parentElement;
    if (!container) return;
    const allRows = Array.from(container.querySelectorAll('.list-row[data-id]'));
    const orderedIds = allRows.map((r) => r.dataset.id).filter(Boolean);
    const fromIdx = orderedIds.indexOf(draggedId);
    const toIdx = orderedIds.indexOf(item.id);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = orderedIds.splice(fromIdx, 1);
    orderedIds.splice(toIdx, 0, moved);

    try {
      await storage.reorderItems(orderedIds);
      renderList();
    } catch (err) {
      toast('Erro ao reordenar: ' + (err.message || err), 'error');
    }
  });

  // Click → editar (mas ignora click no handle e dragend)
  row.addEventListener('click', (e) => {
    if (e.target.closest('.list-handle')) return;
    openItemModal(item);
  });

  return row;
}

function funnelRow(funnel) {
  const row = document.createElement('div');
  row.className = 'list-row list-row--funnel';
  row.onclick = () => openFunnelModal(funnel);
  // Sprint 5 — ícone de tracking depois do nome (mesmo SVG da sidebar)
  const trackingIcon = funnel.trackingEnabled
    ? `<span class="list-track-badge" title="Funil monitorado"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg></span>`
    : '';
  row.innerHTML = `
    <span class="list-badge list-badge--funnel">FUNIL</span>
    <span class="list-name">${escapeHTML(funnel.name || '(sem nome)')}</span>
    ${trackingIcon}
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
    setDropzoneLoading(true);
    try {
      const opus = await convertToOggOpus(file);
      draft.content = opus;
      draft.mimeType = opus.type;
      draft.size = opus.size;
      draft.duration = await getMediaDuration(opus, 'audio');
      toast(`✓ Áudio convertido — ${formatSize(opus.size)}`, 'success');
    } catch (e) {
      console.warn('Conversão OGG falhou:', e);
      toast('Conversão falhou, salvando original (waveform simples)', 'warning');
      draft.content = file;
      draft.mimeType = file.type;
      draft.size = file.size;
      draft.duration = await getMediaDuration(file, 'audio');
    } finally {
      setDropzoneLoading(false);
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

function setDropzoneLoading(loading) {
  const dz = $('dropzone');
  const def = $('dropzone-default');
  const ld = $('dropzone-loading');
  if (!dz || !def || !ld) return;
  dz.classList.toggle('is-loading', !!loading);
  def.hidden = !!loading;
  ld.hidden = !loading;
  // Bloqueia clique abrir file picker durante a conversão
  dz.style.pointerEvents = loading ? 'none' : '';
  // Trava o salvar pra evitar tentar salvar antes da conversão terminar
  const saveBtn = document.querySelector('#form-item button[type="submit"]');
  if (saveBtn) saveBtn.disabled = !!loading;
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

  // Mensagens específicas pelo tipo — usuário leigo precisa de
  // confirmação clara que "subiu" o arquivo dele.
  const TYPE_LABELS = {
    text: 'Mensagem',
    audio: 'Áudio',
    image: 'Imagem',
    video: 'Vídeo',
    file: 'Arquivo',
  };
  const label = TYPE_LABELS[draft.type] || 'Item';

  try {
    if (draft.id) {
      await storage.updateItem(draft.id, draft);
      toast(`✓ ${label} atualizado com sucesso`, 'success');
    } else {
      await storage.addItem(draft);
      toast(`✓ ${label} salvo com sucesso`, 'success');
    }
    $('modal-item').close();
    state.draftItem = null;
    renderList();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  }
}

async function confirmDeleteItem(item) {
  const ok = await confirmModal({
    title: 'Excluir item?',
    body: `"${item.title}" será removido. Essa ação não pode ser desfeita.`,
    confirmLabel: 'Excluir',
  });
  if (!ok) return;
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
    : {
        name: '',
        steps: [],
        // Sprint 5 — defaults dos campos de tracking pra novo funil.
        // Itens existentes já vêm com os defaults aplicados via withFunnelDefaults.
        trackingEnabled: false,
        trackingLabel: null,
        notifyOnComplete: false,
        dailyReportEnabled: false,
      };

  $('modal-funnel-title').textContent = isEdit ? 'Editar funil' : 'Novo funil';
  $('funnel-name').value = state.draftFunnel.name;
  $('btn-delete-funnel').hidden = !isEdit;

  // Cache de items pra referência ao renderizar steps
  state.poolItems = await storage.listItems();
  renderFunnelSteps();

  // Sprint 5 — popula a seção de monitoramento conforme plano + estado salvo
  renderTrackingSection();

  $('modal-funnel').showModal();
  $('funnel-name').focus();
}

// Sprint 5 — Render da seção "Monitoramento" no editor de funil.
// Lê state.draftFunnel + state.planFeatures e atualiza UI.
function renderTrackingSection() {
  const draft = state.draftFunnel;
  if (!draft) return;
  const isPro = !!state.planFeatures.tracking;

  // Reset visibilidade do colapsado
  $('tracking-toggle').setAttribute('aria-expanded', 'false');
  $('tracking-body').hidden = true;

  // Badge "Pro" no header só aparece pra Free
  $('tracking-pro-badge').hidden = isPro;

  // Toggle principal
  const trackingEnabled = $('tracking-enabled');
  trackingEnabled.checked = !!draft.trackingEnabled;
  trackingEnabled.disabled = !isPro;
  trackingEnabled.parentElement.classList.toggle('tracking-row--locked', !isPro);

  // Sub-checkboxes (notify + daily)
  const notify = $('tracking-notify');
  notify.checked = !!draft.notifyOnComplete;
  notify.disabled = !isPro || !draft.trackingEnabled;
  notify.parentElement.classList.toggle('tracking-row--locked', !isPro);

  const daily = $('tracking-daily');
  daily.checked = !!draft.dailyReportEnabled;
  daily.disabled = !isPro || !draft.trackingEnabled;
  daily.parentElement.classList.toggle('tracking-row--locked', !isPro);

  // Label customizado
  const label = $('tracking-label');
  label.value = draft.trackingLabel || '';
  label.disabled = !isPro || !draft.trackingEnabled;
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
    row.addEventListener('click', async () => {
      setStepItemValue(item.id);
      closeStepPanel();
      // Áudio: pré-preenche o delay com a duração do áudio (default
      // sensato — o usuário pode sobrescrever). Itens importados de
      // backup ZapVoice antigo não têm duration salvo; nesse caso
      // calcula on-the-fly e persiste pra evitar recomputar.
      if (item.type === 'audio') {
        let durSec = Number(item.duration);
        if (!(durSec > 0) && item.content instanceof Blob) {
          try {
            const computed = await getMediaDuration(item.content, 'audio');
            if (computed && computed > 0) {
              durSec = computed;
              // Persiste no IndexedDB pra não recalcular toda vez.
              // Best-effort — falha silenciosa não bloqueia o user.
              try {
                await storage.updateItem(item.id, { duration: durSec });
                item.duration = durSec; // refresh ref local
              } catch (_) {}
            }
          } catch (_) {}
        }
        if (durSec > 0) {
          const totalSec = Math.round(durSec);
          const minEl = $('step-delay-min');
          const secEl = $('step-delay-sec');
          if (minEl) minEl.value = Math.floor(totalSec / 60);
          if (secEl) secEl.value = totalSec % 60;
        }
      }
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

  // Sprint 5 — campos de tracking. Só os respeita se o user é Pro;
  // Free user não consegue marcar (UI bloqueia), mas defesa em
  // profundidade aqui evita estado inconsistente caso o storage
  // já tenha algo persistido de uma promoção anterior + downgrade.
  const isPro = !!state.planFeatures.tracking;
  if (isPro) {
    draft.trackingEnabled = $('tracking-enabled').checked;
    draft.notifyOnComplete = draft.trackingEnabled && $('tracking-notify').checked;
    draft.dailyReportEnabled = draft.trackingEnabled && $('tracking-daily').checked;
    const labelVal = $('tracking-label').value.trim();
    draft.trackingLabel = labelVal || null;
  } else {
    // Free: força tudo desligado pra não criar runs órfãos
    draft.trackingEnabled = false;
    draft.notifyOnComplete = false;
    draft.dailyReportEnabled = false;
  }

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
  const ok = await confirmModal({
    title: 'Excluir funil?',
    body: `O funil "${funnel.name}" será removido. Os items usados nele continuam na biblioteca.`,
    confirmLabel: 'Excluir',
  });
  if (!ok) return;
  await storage.deleteFunnel(funnel.id);
  toast('Funil excluído', 'success');
  renderList();
}

// ============================================================
// BACKUP / RESTAURAÇÃO (formato ZapVoice 3.0.0)
// ============================================================
// Modal único com 2 seções: exportar (1 botão direto) e importar
// (file picker → preview → opções → executa → mostra report).

const BACKUP_CATEGORY_LABELS = {
  funnels: 'Funis',
  messages: 'Mensagens',
  audios: 'Áudios',
  medias: 'Mídias',
  docs: 'Documentos',
};
const BACKUP_CATEGORY_CSS = {
  funnels: 'funnel',
  messages: 'text',
  audios: 'audio',
  medias: 'media',
  docs: 'file',
};

function openBackupModal() {
  // Reset do estado a cada abertura
  state.backupFile = null;
  state.backupPreview = null;

  $('backup-file').value = '';
  $('backup-filename').hidden = true;
  $('backup-filename').textContent = '';
  $('backup-preview').hidden = true;
  $('backup-report').hidden = true;
  $('backup-warnings').hidden = true;
  $('btn-do-import').disabled = true;

  // Reset opções pro default
  const skipRadio = document.querySelector('input[name="bk-conflict"][value="skip"]');
  if (skipRadio) skipRadio.checked = true;
  $('bk-regenerate-ids').checked = false;

  $('modal-backup').showModal();
}

async function doExportBackup() {
  const btn = $('btn-do-export');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Gerando...';
  try {
    const blob = await backup.exportBackup();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backup.suggestBackupFilename();
    a.click();
    URL.revokeObjectURL(url);
    toast('✓ Backup baixado com sucesso', 'success');
  } catch (err) {
    console.error('[backup:export]', err);
    toast('Erro no export: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

async function handleBackupFileSelected(file) {
  if (!file) return;

  state.backupFile = file;
  $('backup-filename').textContent = file.name;
  $('backup-filename').hidden = false;
  $('backup-report').hidden = true; // limpa report se trocou de arquivo

  try {
    const preview = await backup.previewBackup(file);
    state.backupPreview = preview;
    renderBackupPreview(preview);
    $('backup-preview').hidden = false;
    $('btn-do-import').disabled = false;
  } catch (err) {
    console.error('[backup:preview]', err);
    state.backupFile = null;
    state.backupPreview = null;
    $('backup-preview').hidden = true;
    $('btn-do-import').disabled = true;
    toast('Arquivo inválido: ' + err.message, 'error');
  }
}

function renderBackupPreview(preview) {
  // Stats por categoria
  const stats = $('backup-stats');
  const total =
    preview.counts.funnels +
    preview.counts.messages +
    preview.counts.audios +
    preview.counts.medias +
    preview.counts.docs;

  if (total === 0) {
    stats.innerHTML = `<div class="bk-stat" style="grid-column:1/-1;text-align:center;">
      <div class="bk-stat-label">Backup vazio (nenhum item ou funil encontrado)</div>
    </div>`;
  } else {
    const order = ['funnels', 'messages', 'audios', 'medias', 'docs'];
    stats.innerHTML = order.map((key) => {
      const count = preview.counts[key];
      const cssMod = BACKUP_CATEGORY_CSS[key];
      const label = BACKUP_CATEGORY_LABELS[key];
      return `
        <div class="bk-stat bk-stat--${cssMod}">
          <div class="bk-stat-value">${count}</div>
          <div class="bk-stat-label">${label}</div>
        </div>
      `;
    }).join('');
  }

  // Avisos
  const warnings = [];
  if (preview.versionMismatch) {
    warnings.push(`⚠ Versão do backup é ${escapeHTML(preview.version)}, esperada 3.x.x. Vou tentar importar mesmo assim — campos novos podem não ser reconhecidos.`);
  }
  if (preview.orphans.length > 0) {
    warnings.push(`⚠ ${preview.orphans.length} entrada(s) sem conteúdo correspondente em objectsList — vão ser ignoradas no import.`);
  }
  const warnEl = $('backup-warnings');
  if (warnings.length) {
    warnEl.innerHTML = warnings.map((w) => `<div>${w}</div>`).join('');
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
  }
}

async function doImportBackup() {
  if (!state.backupFile) return;

  const conflictMode = document.querySelector('input[name="bk-conflict"]:checked')?.value || 'skip';
  const regenerateIds = $('bk-regenerate-ids').checked;

  const btn = $('btn-do-import');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Importando...';

  try {
    const report = await backup.importBackup(state.backupFile, { conflictMode, regenerateIds });
    renderBackupReport(report);
    $('backup-report').hidden = false;

    const totalImported =
      report.imported.funnels +
      report.imported.messages +
      report.imported.audios +
      report.imported.medias +
      report.imported.docs;

    if (totalImported > 0) {
      toast(`✓ Backup importado — ${totalImported} item(ns) adicionado(s)`, 'success');
    } else {
      toast('Nenhum item novo importado (tudo pulado ou órfão)', 'warning');
    }

    // Atualiza a lista de fundo (próximo render reflete os novos items)
    renderList();
  } catch (err) {
    console.error('[backup:import]', err);
    toast('Erro no import: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function renderBackupReport(report) {
  const order = ['funnels', 'messages', 'audios', 'medias', 'docs'];
  const tbody = $('backup-report-body');
  tbody.innerHTML = order.map((key) => {
    const imp = report.imported[key];
    const skp = report.skipped[key];
    const impCls = imp > 0 ? 'bk-num--ok' : 'bk-num--zero';
    const skpCls = skp > 0 ? '' : 'bk-num--zero';
    return `
      <tr>
        <td>${BACKUP_CATEGORY_LABELS[key]}</td>
        <td class="bk-num ${impCls}">${imp}</td>
        <td class="bk-num ${skpCls}">${skp}</td>
      </tr>
    `;
  }).join('');

  const extras = $('backup-report-extras');
  const pills = [];
  if (report.orphans.length > 0) {
    pills.push(`<div class="bk-report-pill bk-report-pill--warning">${report.orphans.length} entrada(s) órfã(s) — sem conteúdo correspondente em objectsList</div>`);
  }
  if (report.errors.length > 0) {
    const sample = report.errors.slice(0, 3).map(e =>
      `${e.kind || 'item'}${e.id ? ` (${e.id.slice(0, 8)}...)` : ''}: ${e.message}`
    ).join(' · ');
    const more = report.errors.length > 3 ? ` e +${report.errors.length - 3}` : '';
    pills.push(`<div class="bk-report-pill bk-report-pill--error">${report.errors.length} erro(s)${more}: ${escapeHTML(sample)}</div>`);
  }
  extras.innerHTML = pills.join('');
}

async function doClearAll() {
  try {
    const [items, funnels] = await Promise.all([storage.listItems(), storage.listFunnels()]);
    const total = items.length + funnels.length;

    if (total === 0) {
      toast('Nada pra apagar — biblioteca já está vazia', 'info');
      return;
    }

    const first = await confirmModal({
      title: 'Apagar TUDO?',
      bodyHtml: `
        <p style="margin-bottom:10px;">Isso vai remover permanentemente:</p>
        <ul style="margin:0 0 14px 18px;line-height:1.6;color:var(--text-dim);">
          <li><strong>${items.length}</strong> item(ns) (mensagens, áudios, mídias, arquivos)</li>
          <li><strong>${funnels.length}</strong> funil(is)</li>
        </ul>
        <p style="color:var(--accent);font-weight:600;margin-bottom:8px;">Essa ação NÃO pode ser desfeita.</p>
        <p style="color:var(--text-dim);font-size:13px;">Dica: exporte um backup antes, se quiser poder restaurar depois.</p>
      `,
      confirmLabel: 'Apagar tudo',
    });
    if (!first) return;

    const second = await confirmModal({
      title: 'Tem certeza absoluta?',
      body: 'Última chance antes de apagar tudo.',
      confirmLabel: 'Sim, apagar',
    });
    if (!second) return;

    const result = await storage.clearAll();
    toast(`Apagados ${result.clearedItems} itens e ${result.clearedFunnels} funis`, 'success');
    renderList();
  } catch (err) {
    toast('Erro ao apagar: ' + err.message, 'error');
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

  // Backup / Restauração — modal único com export + import
  $('btn-backup').addEventListener('click', openBackupModal);
  $('btn-do-export').addEventListener('click', doExportBackup);
  $('btn-pick-backup').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleBackupFileSelected(f);
  });
  $('btn-do-import').addEventListener('click', doImportBackup);

  // Apagar tudo (separado do backup, ação destrutiva direta)
  $('btn-clear-all').addEventListener('click', doClearAll);

  // Abrir painel do assinante em nova aba (URL vem de config.js — build-replaced)
  $('btn-panel').addEventListener('click', () => {
    window.open(`${PANEL_URL}/dashboard`, '_blank', 'noopener,noreferrer');
  });

  // Hash navigation: #edit=ITEM_ID ou #funnel=FUNNEL_ID
  handleHashFocus();
  window.addEventListener('hashchange', handleHashFocus);

  // Sprint 5 — Wiring da seção de monitoramento
  setupTrackingWiring();
  // Sprint 5 ETAPA C — submit do form de entrega automática
  $('form-delivery').addEventListener('submit', saveDeliveryConfigFromModal);
  // Carrega plan.features do chrome.storage e observa mudanças
  loadPlanFeatures();

  // Sprint 5 — Reconciliação de runs órfãos. Conserta runs que ficaram
  // presos em 'running' por race condition (pre-fix) ou por aba fechada
  // no meio. Roda ANTES da retention pra que runs reconciliados como
  // 'completed' não sejam confundidos com lixo.
  reconcileOrphanRuns().then(({ fixed, failed }) => {
    if (fixed > 0) console.log(`[Zapfire][manager] reconcile: ${fixed} run(s) marcado(s) completed retroativamente`);
    if (failed > 0) console.log(`[Zapfire][manager] reconcile: ${failed} run(s) zumbi marcado(s) failed (>24h sem terminar)`);
    // Refresca a UI se a tab Reports / dashboard estão abertas
    if (fixed > 0 || failed > 0) renderList();
  }).catch((err) => {
    console.warn('[Zapfire][manager] reconcile falhou:', err);
  });

  // Sprint 5 — Retention policy: apaga runs com finishedAt < 90d.
  // Roda em background, não bloqueia o init. 90d é hardcoded por agora —
  // configurável via meta storage no futuro se virar pedido.
  const RETENTION_MS = 90 * 86400_000;
  storage.deleteRunsOlderThan(Date.now() - RETENTION_MS).then((n) => {
    if (n > 0) console.log(`[Zapfire][manager] retention: ${n} runs antigos removidos (>90d)`);
  }).catch((err) => {
    console.warn('[Zapfire][manager] retention falhou:', err);
  });

  renderList();
}

// Sprint 5 — listeners do colapsável + gate Pro + sync de sub-checkboxes
function setupTrackingWiring() {
  // Colapsável
  $('tracking-toggle').addEventListener('click', () => {
    const expanded = $('tracking-toggle').getAttribute('aria-expanded') === 'true';
    $('tracking-toggle').setAttribute('aria-expanded', !expanded);
    $('tracking-body').hidden = expanded;
  });

  // Toggle principal: se Free e tentou marcar, abre modal de upgrade
  $('tracking-enabled').addEventListener('change', (e) => {
    if (!state.planFeatures.tracking) {
      // UI já bloqueia via disabled, mas defesa em profundidade
      e.target.checked = false;
      openUpgradeProModal();
      return;
    }
    // Habilita/desabilita sub-checkboxes conforme o principal
    state.draftFunnel.trackingEnabled = e.target.checked;
    renderTrackingSection();
  });

  // Click na linha bloqueada (Free) também abre modal de upgrade
  $('tracking-enabled').parentElement.addEventListener('click', (e) => {
    if (!state.planFeatures.tracking && e.target.tagName !== 'INPUT') {
      openUpgradeProModal();
    }
  });
}

function openUpgradeProModal() {
  // PANEL_URL vem do config.js — build-replaced pra prod
  $('btn-upgrade-link').href = `${PANEL_URL}/assinatura?upgrade=pro`;
  $('modal-upgrade-pro').showModal();
}

async function loadPlanFeatures() {
  try {
    const stored = await chrome.storage.local.get('zf_plan_features');
    state.planFeatures = stored.zf_plan_features || {};
  } catch (_) {
    state.planFeatures = {};
  }
  // Observa mudanças (ex: user faz upgrade pra Pro e novo /validate
  // pelo content script atualiza o storage — manager reflete na hora).
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.zf_plan_features) {
        state.planFeatures = changes.zf_plan_features.newValue || {};
        // Se o modal de funil estiver aberto, re-renderiza pra refletir
        if (state.draftFunnel && $('modal-funnel').open) {
          renderTrackingSection();
        }
      }
    });
  }
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
