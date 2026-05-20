// ============================================================
// ZAPFIRE — Sidebar (controller)
// ============================================================
// Roda dentro do iframe injetado em web.whatsapp.com.
// Como o iframe está na origem chrome-extension://, ele
// compartilha IndexedDB com o manager — tudo que o usuário
// criar no manager aparece aqui.
//
// Fluxo:
//   1. Lê items/funnels do storage local (IndexedDB)
//   2. Renderiza cards conforme a tab ativa
//   3. Quando usuário clica "Enviar", manda postMessage pro
//      content script (parent), que executa o sender.js
//   4. Recebe resposta via postMessage e mostra toast
//
// Funis paralelos:
//   Vários funis podem rodar ao mesmo tempo, cada um ancorado
//   à conversa onde foi iniciado. Antes de cada send, a sidebar
//   pede pro content script trocar pra conversa de origem do
//   funil. A engine serializa os sends globalmente pra que dois
//   funis não disputem a UI simultaneamente.
// ============================================================

import {
  listItems,
  listFunnels,
  getMeta,
  setMeta,
  incrementItemUses,
  // Sprint 5+ — QuickSearch handlers precisam pegar item/funnel
  // completos (com blob) pra despachar envio
  getItem,
  getFunnel,
} from '../lib/storage.js';
import { runFunnel } from '../lib/funnel-engine.js';
// Sprint 5 — wrapper que registra runs em funnel_runs quando o funil
// tem trackingEnabled. Pra funis sem tracking é passthrough direto.
import { runFunnelWithTracking } from '../lib/funnel-tracker.js';
import {
  subscribeLicenseState,
  renderBannerInto,
  canSend,
  isBlocked,
  blockReason,
} from '../lib/grace-banner.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------
// Estado da UI
// ------------------------------------------------------------
const state = {
  activeTab: 'funnels',    // funnels | text | audio | media | activity
  search: '',
  chatOpen: false,
  chatName: null,
  // Map<runId, RunInfo> — funis em execução
  // RunInfo: { runId, funnelId, funnelName, totalSteps, target, cancel,
  //            phase, current, status, progressPct, countdownTimer }
  activeRuns: new Map(),
  // Sprint 4 — estado da licença (atualizado via chrome.storage.onChanged).
  // null = ainda não carregou (permissivo até primeiro validate).
  license: null,
};

const TAB_FILTERS = {
  funnels: { types: null },
  text: { types: ['text'] },
  audio: { types: ['audio'] },
  media: { types: ['image', 'video', 'file'] },
  activity: { types: null },
};

const TAB_LABELS = {
  funnels: 'funil',
  text: 'mensagem',
  audio: 'áudio',
  media: 'mídia',
  activity: 'execução',
};

// ------------------------------------------------------------
// Bridge com o content script (parent)
// ------------------------------------------------------------
const pendingRequests = new Map();

function callParent(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingRequests.set(requestId, { resolve, reject });
    window.parent.postMessage({ type, requestId, ...payload }, '*');
    // Timeout 30s
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('Timeout aguardando content script'));
      }
    }, 30_000);
  });
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ZF_RESPONSE' && msg.requestId) {
    const pending = pendingRequests.get(msg.requestId);
    if (pending) {
      pendingRequests.delete(msg.requestId);
      pending.resolve(msg.result);
    }
    return;
  }

  if (msg.type === 'ZF_CHAT_STATE') {
    state.chatOpen = !!msg.isOpen;
    state.chatName = msg.chatName || null;
    updateChatLabel();
    updateSendButtons();
    return;
  }

  // QuickBar pediu pra executar um funil — sidebar é dona dos runs
  if (msg.type === 'ZF_RUN_FUNNEL_FROM_QB' && msg.funnelId) {
    try {
      const funnel = await (await import('../lib/storage.js')).getFunnel(msg.funnelId);
      if (funnel) handleRunFunnel(funnel);
    } catch (err) {
      console.warn('[Zapfire][sidebar] erro ao iniciar funil do QB:', err.message);
    }
    return;
  }

  // Content script pediu pra focar a tab Ativos (ex: clicou no
  // indicador piscante da conversa)
  if (msg.type === 'ZF_FOCUS_ACTIVITY') {
    setActiveTab('activity');
    return;
  }
});

// ------------------------------------------------------------
// Toast
// ------------------------------------------------------------
let toastTimer = null;
function toast(message, type = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = 'sb-toast ' + type;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// Toast global (content script nível viewport) — visível mesmo
// quando a sidebar está fechada
function globalToast(message, type = 'info') {
  window.parent.postMessage({ type: 'ZF_TOAST', message, toastType: type }, '*');
}

// Broadcast lista de JIDs que têm funis ativos pro content script.
// Chamado sempre que state.activeRuns muda (add/delete). Content
// script usa pra mostrar o indicador piscante no chat alvo.
function broadcastActiveRuns() {
  const jids = Array.from(state.activeRuns.values())
    .map((r) => r.target?.jid)
    .filter(Boolean);
  console.log('[Zapfire][sidebar] broadcast active jids:', jids);
  window.parent.postMessage({ type: 'ZF_ACTIVE_RUNS_CHANGED', jids }, '*');
}

// ------------------------------------------------------------
// Header — chat name
// ------------------------------------------------------------
function updateChatLabel() {
  const el = $('chat-name');
  if (state.chatOpen && state.chatName) {
    el.textContent = '→ ' + state.chatName;
  } else if (state.chatOpen) {
    el.textContent = 'Chat aberto';
  } else {
    el.textContent = 'Abra uma conversa';
  }
}

function updateSendButtons() {
  const blocked = isBlocked(state.license);
  const blockMsg = blocked
    ? 'Envios bloqueados — renove sua assinatura'
    : null;
  document.querySelectorAll('.card-btn.primary').forEach((btn) => {
    if (btn.dataset.alwaysOn === '1') return; // botões em activity não dependem
    btn.disabled = !state.chatOpen || blocked;
    btn.title = blockMsg || (state.chatOpen ? '' : 'Abra uma conversa primeiro');
  });
}

// ------------------------------------------------------------
// Renderização da lista
// ------------------------------------------------------------
async function renderList() {
  const list = $('list');

  if (state.activeTab === 'activity') {
    renderActivityCards(list);
    return;
  }

  if (state.activeTab === 'funnels') {
    const funnels = await listFunnels();
    const filtered = state.search
      ? funnels.filter((f) => f.name.toLowerCase().includes(state.search.toLowerCase()))
      : funnels;
    renderFunnelCards(list, filtered);
    return;
  }

  const filter = TAB_FILTERS[state.activeTab];
  const all = [];
  for (const type of filter.types) {
    const items = await listItems({ type, search: state.search || undefined });
    all.push(...items);
  }
  all.sort((a, b) => b.createdAt - a.createdAt);
  renderItemCards(list, all);
}

function renderItemCards(container, items) {
  if (!items.length) {
    container.innerHTML = emptyStateHTML();
    return;
  }
  container.innerHTML = '';
  for (const item of items) container.appendChild(itemCard(item));
  updateSendButtons();
}

function renderFunnelCards(container, funnels) {
  if (!funnels.length) {
    container.innerHTML = emptyStateHTML();
    return;
  }
  container.innerHTML = '';
  for (const funnel of funnels) container.appendChild(funnelCard(funnel));
  updateSendButtons();
}

function renderActivityCards(container) {
  const runs = Array.from(state.activeRuns.values());
  if (!runs.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">▶</div>
        <div class="empty-title">Nenhum funil em execução</div>
        <div class="empty-sub">Abra a aba Funis e clique em "Executar" pra começar.</div>
      </div>
    `;
    return;
  }
  container.innerHTML = '';
  for (const run of runs) container.appendChild(activityCard(run));
}

function emptyStateHTML() {
  const label = TAB_LABELS[state.activeTab];
  return `
    <div class="empty">
      <div class="empty-icon">+</div>
      <div class="empty-title">Sem ${label}s aqui</div>
      <div class="empty-sub">Abra o gerenciador no rodapé pra criar.</div>
    </div>
  `;
}

// ------------------------------------------------------------
// Cards
// ------------------------------------------------------------
function itemCard(item) {
  const colorKey = typeColorKey(item.type);

  const card = document.createElement('div');
  card.className = `card collapsed card--${colorKey}`;
  card.dataset.id = item.id;

  // Row principal: badge + nome + chevron + ação
  const head = document.createElement('div');
  head.className = 'card-head';

  const leftSide = document.createElement('div');
  leftSide.className = 'card-head-left';

  const typeBadge = document.createElement('span');
  typeBadge.className = `card-type card-type--${colorKey}`;
  typeBadge.textContent = badgeFor(item.type);
  leftSide.appendChild(typeBadge);

  const titleText = document.createElement('span');
  titleText.className = 'card-title-text';
  titleText.textContent = item.title;
  leftSide.appendChild(titleText);

  head.appendChild(leftSide);

  const chevron = document.createElement('button');
  chevron.className = 'card-chevron';
  chevron.type = 'button';
  chevron.textContent = '▾';
  chevron.title = 'Expandir';
  chevron.onclick = (e) => {
    e.stopPropagation();
    const expanded = card.classList.toggle('collapsed') === false;
    chevron.textContent = expanded ? '▴' : '▾';
    chevron.title = expanded ? 'Recolher' : 'Expandir';
  };
  head.appendChild(chevron);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'card-btn primary';
  sendBtn.textContent = 'Enviar';
  sendBtn.disabled = !state.chatOpen;
  sendBtn.title = state.chatOpen ? '' : 'Abra uma conversa primeiro';
  sendBtn.onclick = (e) => { e.stopPropagation(); handleSendItem(item); };
  head.appendChild(sendBtn);

  card.appendChild(head);

  // Detalhes (só visíveis quando expandido)
  const details = document.createElement('div');
  details.className = 'card-details';
  details.appendChild(itemPreview(item));

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if (item.uses) meta.appendChild(metaSpan(`${item.uses} envios`));
  if (item.size) meta.appendChild(metaSpan(formatSize(item.size)));
  if (item.duration) meta.appendChild(metaSpan(formatDuration(item.duration)));
  if (meta.children.length) details.appendChild(meta);

  card.appendChild(details);
  return card;
}

function badgeFor(type) {
  const map = { text: 'MSG', audio: 'ÁUDIO', image: 'IMG', video: 'VÍDEO', file: 'ARQ' };
  return map[type] || type.toUpperCase();
}

// Chave de cor — agrupa image/video/file como "media"
function typeColorKey(type) {
  if (type === 'text') return 'text';
  if (type === 'audio') return 'audio';
  if (type === 'image' || type === 'video' || type === 'file') return 'media';
  return 'funnel';
}

function itemPreview(item) {
  const preview = document.createElement('div');
  preview.className = 'card-preview';

  if (item.type === 'text') {
    const txt = String(item.content || '');
    preview.textContent = txt.length > 100 ? txt.slice(0, 100) + '...' : txt;
    return preview;
  }
  if (item.type === 'image' && item.thumbnail instanceof Blob) {
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = URL.createObjectURL(item.thumbnail);
    img.onload = () => URL.revokeObjectURL(img.src);
    return img;
  }
  if (item.type === 'video' && item.thumbnail instanceof Blob) {
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = URL.createObjectURL(item.thumbnail);
    img.onload = () => URL.revokeObjectURL(img.src);
    return img;
  }
  if (item.type === 'audio' && item.content instanceof Blob) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.style.cssText = 'width: 100%; height: 32px;';
    audio.src = URL.createObjectURL(item.content);
    return audio;
  }
  preview.textContent = item.mimeType || '(sem preview)';
  return preview;
}

function funnelCard(funnel) {
  const card = document.createElement('div');
  card.className = 'card collapsed card--funnel';

  const head = document.createElement('div');
  head.className = 'card-head';

  const leftSide = document.createElement('div');
  leftSide.className = 'card-head-left';

  const badge = document.createElement('span');
  badge.className = 'card-type card-type--funnel';
  badge.textContent = 'FUNIL';
  leftSide.appendChild(badge);

  const titleText = document.createElement('span');
  titleText.className = 'card-title-text';
  titleText.textContent = funnel.name;
  leftSide.appendChild(titleText);

  // Sprint 5 — indicador discreto de tracking ativo
  if (funnel.trackingEnabled) {
    const trackBadge = document.createElement('span');
    trackBadge.className = 'card-track-badge';
    trackBadge.title = 'Funil monitorado — leads que chegarem ao final aparecem em Relatórios';
    // SVG de "barras de relatório" estilo Lucide
    trackBadge.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>';
    leftSide.appendChild(trackBadge);
  }

  head.appendChild(leftSide);

  const chevron = document.createElement('button');
  chevron.className = 'card-chevron';
  chevron.type = 'button';
  chevron.textContent = '▾';
  chevron.title = 'Expandir';
  chevron.onclick = (e) => {
    e.stopPropagation();
    const expanded = card.classList.toggle('collapsed') === false;
    chevron.textContent = expanded ? '▴' : '▾';
    chevron.title = expanded ? 'Recolher' : 'Expandir';
  };
  head.appendChild(chevron);

  const runBtn = document.createElement('button');
  runBtn.className = 'card-btn primary';
  runBtn.textContent = 'Executar';
  runBtn.disabled = !state.chatOpen;
  runBtn.title = state.chatOpen ? 'Inicia o funil pra conversa atual' : 'Abra uma conversa primeiro';
  runBtn.onclick = (e) => { e.stopPropagation(); handleRunFunnel(funnel); };
  head.appendChild(runBtn);

  card.appendChild(head);

  // Detalhes expansíveis
  const details = document.createElement('div');
  details.className = 'card-details';

  const stepsList = document.createElement('div');
  stepsList.className = 'card-preview';
  stepsList.textContent = `${funnel.steps.length} step(s)`;
  details.appendChild(stepsList);

  card.appendChild(details);
  return card;
}

// Card de execução em andamento (tab Ativos)
function activityCard(run) {
  const card = document.createElement('div');
  card.className = 'activity-card';
  card.dataset.runId = run.runId;

  const head = document.createElement('div');
  head.className = 'activity-head';
  const name = document.createElement('strong');
  name.textContent = run.funnelName;
  head.appendChild(name);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'activity-cancel';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.onclick = () => cancelRun(run.runId);
  head.appendChild(cancelBtn);
  card.appendChild(head);

  // Linha "→ Para: X" clicável — abre o chat do lead no WA Web
  // via WPP.chat.openChatBottom (mesma rota do botão "Abrir conversa"
  // da tab Relatórios no manager, Sprint 5)
  const target = document.createElement('button');
  target.type = 'button';
  target.className = 'activity-target';
  target.textContent = '→ Para: ' + (run.target?.name || '?');
  target.title = 'Clique pra abrir a conversa';
  target.onclick = (e) => {
    e.stopPropagation();
    const jid = run.target?.jid;
    if (!jid) {
      toast('Sem JID — não consegui abrir', 'warning');
      return;
    }
    callParent('ZF_OPEN_CHAT_BY_JID', { jid, name: run.target?.name || '' })
      .then((result) => {
        if (!result?.ok) toast(result?.error || 'Falha ao abrir', 'error');
      })
      .catch(() => toast('Falha ao abrir conversa', 'error'));
  };
  card.appendChild(target);

  const status = document.createElement('div');
  status.className = 'activity-status';
  status.id = `run-status-${run.runId}`;
  status.textContent = run.status || 'Iniciando...';
  card.appendChild(status);

  const bar = document.createElement('div');
  bar.className = 'activity-bar';
  const fill = document.createElement('div');
  fill.className = 'activity-bar-fill';
  fill.id = `run-bar-${run.runId}`;
  fill.style.width = (run.progressPct || 0) + '%';
  bar.appendChild(fill);
  card.appendChild(bar);

  return card;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function metaSpan(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// Envio avulso (1 item)
// ------------------------------------------------------------
async function handleSendItem(item) {
  // Gate de licença (Sprint 4 ETAPA 7) — bloqueio client-side minimalista.
  // Validação de verdade é server-side; isso é só pra feedback imediato.
  if (!canSend(state.license)) {
    globalToast('Assinatura indisponível — renove pra continuar enviando', 'error');
    return;
  }

  if (!state.chatOpen) {
    toast('Abra uma conversa primeiro', 'warning');
    return;
  }

  // Captura JID do chat aberto pra usar a API (invisível + áudio
  // como PTT real). Sem JID cai no fallback DOM (legacy).
  let jid = null;
  try {
    const idRes = await callParent('ZF_GET_CHAT_ID');
    if (idRes?.ok && idRes.target?.jid) jid = idRes.target.jid;
  } catch (_) {}

  if (item.type === 'text') {
    await dispatchSend(item, 'ZF_SEND_TEXT', { jid, text: item.content });
    return;
  }

  if (item.type === 'image' || item.type === 'video' || item.type === 'file') {
    if (!(item.content instanceof Blob)) {
      toast('Item sem conteúdo binário', 'error');
      return;
    }
    await dispatchSend(item, 'ZF_SEND_MEDIA', {
      jid,
      blob: item.content,
      caption: item.caption || '',
      mediaType: item.type,
    });
    return;
  }

  if (item.type === 'audio') {
    if (!(item.content instanceof Blob)) {
      toast('Áudio sem conteúdo binário', 'error');
      return;
    }
    await dispatchSend(item, 'ZF_SEND_AUDIO', { jid, blob: item.content });
    return;
  }

  toast(`Tipo desconhecido: ${item.type}`, 'error');
}

async function dispatchSend(item, msgType, payload) {
  toast('Enviando...', 'info');
  try {
    const result = await callParent(msgType, payload);
    if (result.ok) {
      await incrementItemUses(item.id);
      toast('Enviado', 'success');
      renderList();
    } else {
      toast(result.error || 'Falha no envio', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openManager(focus) {
  callParent('ZF_OPEN_MANAGER', { focus }).catch(() => {});
}

function closeSidebar() {
  window.parent.postMessage({ type: 'ZF_CLOSE_SIDEBAR' }, '*');
}

// ------------------------------------------------------------
// Funil — execução (parallel-ready)
// ------------------------------------------------------------

// Builder de sendItem ancorado a uma conversa específica.
// Antes de cada envio: pede pro content script trocar pra essa
// conversa. Se a troca falhar (WA bloqueia clicks sintéticos
// em algumas versões), faz auto-retry por até 30s — dando
// janela pro usuário abrir manualmente a conversa, que aí o
// switch passa direto (alreadyOpen).
//
// Esse comportamento de "pausa até você abrir" é o fallback
// quando o switch programático não funciona. Em versões do WA
// onde o switch funciona, o primeiro try resolve em <1s.
// Sender ancorado — tudo via API interna (invisível, independe
// do chat aberto). Texto vai via módulos nativos do WA, mídia
// e áudio vão via WPP (WA-JS).
function makeAnchoredSender(target, runId) {
  return async (item) => {
    const run = state.activeRuns.get(runId);
    if (!run || run.cancelledFlag) return { ok: false, error: 'cancelado' };

    if (!target.jid) {
      return {
        ok: false,
        error: 'JID não capturado — conversa sem data-id. Abra a conversa uma vez pra capturar.',
      };
    }

    // Presença "digitando" / "gravando" não acontece aqui — é
    // disparada no onRunProgress quando o engine entra em waiting.
    // Aqui só executa o send em si.

    // fromRunId é o "selo" que diz ao gate em content.js que esse
    // envio veio do funil rodando (e portanto não deve ser bloqueado
    // pelo gate de "lead com funil ativo").
    if (item.type === 'text') {
      return await callParent('ZF_SEND_TEXT', {
        jid: target.jid,
        text: item.content,
        fromRunId: runId,
      });
    }

    if (item.type === 'image' || item.type === 'video' || item.type === 'file') {
      if (!(item.content instanceof Blob)) {
        return { ok: false, error: 'mídia sem blob' };
      }
      return await callParent('ZF_SEND_MEDIA', {
        jid: target.jid,
        blob: item.content,
        caption: item.caption || '',
        mediaType: item.type,
        fromRunId: runId,
      });
    }

    if (item.type === 'audio') {
      if (!(item.content instanceof Blob)) {
        return { ok: false, error: 'áudio sem blob' };
      }
      return await callParent('ZF_SEND_AUDIO', {
        jid: target.jid,
        blob: item.content,
        fromRunId: runId,
      });
    }

    return { ok: false, error: `tipo desconhecido: ${item.type}` };
  };
}

// Envio bruto via content script — usado pelo sender ancorado e
// por handleSendItem (este último não precisa ancorar porque o
// usuário já escolheu manualmente o chat aberto)
async function sendItemViaParent(item) {
  if (item.type === 'text') {
    return await callParent('ZF_SEND_TEXT', { text: item.content });
  }
  if (item.type === 'audio') {
    if (!(item.content instanceof Blob)) {
      return { ok: false, error: 'Áudio sem conteúdo binário' };
    }
    return await callParent('ZF_SEND_AUDIO', { blob: item.content });
  }
  if (item.type === 'image' || item.type === 'video' || item.type === 'file') {
    if (!(item.content instanceof Blob)) {
      return { ok: false, error: 'Mídia sem conteúdo binário' };
    }
    return await callParent('ZF_SEND_MEDIA', {
      blob: item.content,
      caption: item.caption || '',
      mediaType: item.type,
    });
  }
  return { ok: false, error: `Tipo desconhecido: ${item.type}` };
}

async function handleRunFunnel(funnel) {
  // Gate de licença (Sprint 4 ETAPA 7)
  if (!canSend(state.license)) {
    globalToast('Assinatura indisponível — renove pra executar funis', 'error');
    return;
  }

  if (!state.chatOpen) {
    toast('Abra uma conversa primeiro', 'warning');
    return;
  }

  // Captura a identidade do chat aberto (vai ancorar o funil)
  const idResult = await callParent('ZF_GET_CHAT_ID');
  if (!idResult || !idResult.ok || !idResult.target) {
    toast('Não consegui identificar a conversa aberta', 'error');
    return;
  }
  const target = idResult.target;

  // Gate de funil duplicado pro mesmo lead. Bloqueia disparo de
  // qualquer funil enquanto já tem outro rodando pra mesma conversa
  // (evita lead recebendo 2 sequências intercaladas).
  // O check + state.activeRuns.set abaixo rodam síncronamente — não há
  // await entre eles, então cliques múltiplos em sequência não dão race.
  if (target.jid) {
    for (const r of state.activeRuns.values()) {
      if (r.target && r.target.jid === target.jid) {
        globalToast(
          `Já tem o funil "${r.funnelName}" rodando pra essa conversa. Cancele na tab Ativos antes de iniciar outro.`,
          'warning'
        );
        return;
      }
    }
  }

  // Cria o run ID antes pra poder passar pro sender ancorado
  // (que precisa checar cancellation durante retries longos)
  const tempRunId = crypto.randomUUID();
  const sendItem = makeAnchoredSender(target, tempRunId);
  // Sprint 5 — runFunnelWithTracking faz passthrough se trackingEnabled=false,
  // ou registra os hooks de telemetria se trackingEnabled=true.
  // Mantém os mesmos sendItem/onProgress que sempre usamos.
  const run = runFunnelWithTracking(funnel, target, {
    sendItem,
    onProgress: (ev) => onRunProgress(tempRunId, ev),
  });

  // Registra no Map (usa o tempRunId como chave, run.runId é interno do engine)
  const runInfo = {
    runId: tempRunId,
    engineRunId: run.runId,
    funnelId: funnel.id,
    funnelName: funnel.name,
    totalSteps: funnel.steps.length,
    target,
    cancel: () => {
      // Marca flag pra abortar retries pendentes do anchored sender
      const r = state.activeRuns.get(tempRunId);
      if (r) r.cancelledFlag = true;
      run.cancel();
    },
    cancelledFlag: false,
    phase: 'starting',
    current: 0,
    status: 'Iniciando...',
    progressPct: 0,
    countdownTimer: null,
  };
  state.activeRuns.set(tempRunId, runInfo);
  updateActivityBadge();
  broadcastActiveRuns();
  // Re-renderiza pra exibir o card (se estiver na tab Ativos)
  // ou só atualiza o badge (se estiver em outra tab)
  if (state.activeTab === 'activity') renderList();

  // Feedback imediato via toast global (content script)
  globalToast(`Funil "${funnel.name}" iniciado → ${target.name || ''}`, 'info');
  console.log('[Zapfire][sidebar] funil iniciado:', funnel.name, 'runId:', tempRunId);

  // Aguarda finalização — cleanup SEMPRE roda via finally pra
  // garantir que o badge e Map voltem ao estado consistente
  let result = { ok: false, error: 'unknown' };
  try {
    result = await run.promise;
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
  } finally {
    if (runInfo.countdownTimer) clearInterval(runInfo.countdownTimer);
    state.activeRuns.delete(tempRunId);
    updateActivityBadge();
    broadcastActiveRuns();
    if (state.activeTab === 'activity') renderList();
    console.log('[Zapfire][sidebar] funil finalizado:', funnel.name, 'runs ativos restantes:', state.activeRuns.size);
  }

  if (result.cancelled) {
    globalToast(`Funil "${funnel.name}" cancelado (${result.completed} steps)`, 'warning');
  } else if (result.ok) {
    globalToast(`Funil "${funnel.name}" concluído (${result.completed}/${funnel.steps.length})`, 'success');
  } else {
    globalToast(`Funil "${funnel.name}" falhou: ` + (result.error || ''), 'error');
  }
}

// Atualiza UI de UM run específico
function onRunProgress(runId, ev) {
  const run = state.activeRuns.get(runId);
  if (!run) return;

  // Limpa countdown anterior se mudou de fase
  if (run.countdownTimer) {
    clearInterval(run.countdownTimer);
    run.countdownTimer = null;
  }

  run.phase = ev.phase;
  run.current = ev.current;

  if (ev.phase === 'waiting') {
    // Live countdown — tick a cada 1s
    const startedAt = Date.now();
    const totalMs = ev.delayMs;
    const tick = () => {
      const r = state.activeRuns.get(runId);
      if (!r) return;
      const remaining = Math.max(0, Math.ceil((totalMs - (Date.now() - startedAt)) / 1000));
      r.status = `Aguardando ${remaining}s antes de ${ev.current}/${ev.total}...`;
      paintRunStatus(runId);
      if (remaining <= 0 && r.countdownTimer) {
        clearInterval(r.countdownTimer);
        r.countdownTimer = null;
      }
    };
    tick();
    run.countdownTimer = setInterval(tick, 1000);

    // Presença pro contato durante a espera (só se temos item info do
    // engine — Sprint pós-CWS). Texto = "digitando", áudio = "gravando".
    // Mídia/arquivo: nada (envio direto). Duração da presença = delay
    // do step, com mín 1.5s pra ser visível e máx 60s pra não estourar.
    if (ev.item && run.target?.jid) {
      const kind =
        ev.item.type === 'text' ? 'typing' :
        ev.item.type === 'audio' ? 'recording' :
        null;
      if (kind) {
        const presenceMs = Math.min(60000, Math.max(1500, ev.delayMs));
        callParent('ZF_SET_PRESENCE', {
          jid: run.target.jid,
          kind,
          durationMs: presenceMs,
        }).catch(() => {});
      }
    }
  } else if (ev.phase === 'sending') {
    run.status = `Enviando ${ev.current}/${ev.total}: ${ev.item.title}`;
  } else if (ev.phase === 'sent') {
    run.status = `${ev.current}/${ev.total} enviado: ${ev.item.title}`;
    run.progressPct = Math.round((ev.current / ev.total) * 100);
  } else if (ev.phase === 'error') {
    const t = ev.item ? ev.item.title : '(item)';
    run.status = `Erro em ${ev.current}/${ev.total}: ${t} — ${ev.error}`;
  }

  paintRunStatus(runId);
}

// Atualiza só o status/barra de um run específico no DOM (sem
// re-renderizar a lista inteira — evita flicker dos cards de
// outros runs)
function paintRunStatus(runId) {
  const run = state.activeRuns.get(runId);
  if (!run) return;

  // Se a tab ativa não é Ativos, ainda assim atualiza o estado
  // no map — quando o usuário abrir Ativos vai aparecer correto.
  if (state.activeTab !== 'activity') return;

  const statusEl = $(`run-status-${runId}`);
  const fillEl = $(`run-bar-${runId}`);
  if (statusEl) statusEl.textContent = run.status;
  if (fillEl) fillEl.style.width = (run.progressPct || 0) + '%';

  // Se o card ainda não existe (run novo), re-renderiza
  if (!statusEl) renderList();
}

async function cancelRun(runId) {
  const run = state.activeRuns.get(runId);
  if (!run) return;
  const confirmed = await callParent('ZF_CONFIRM', {
    message: `Deseja realmente cancelar o funil "${run.funnelName}" em execução para "${run.target?.name || 'a conversa'}"?`,
    confirmLabel: 'Cancelar funil',
    cancelLabel: 'Continuar envio',
  });
  if (confirmed?.ok) run.cancel();
}

function updateActivityBadge() {
  const badge = $('activity-badge');
  const count = state.activeRuns.size;
  if (count > 0) {
    badge.textContent = String(count);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ------------------------------------------------------------
// Tabs
// ------------------------------------------------------------
function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.sb-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  // Não persiste a tab "activity" como preferência (é transitória)
  if (tab !== 'activity') setMeta('lastTab', tab).catch(() => {});
  renderList();
}

// ------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------
async function init() {
  const lastTab = await getMeta('lastTab', 'text');
  if (TAB_FILTERS[lastTab]) state.activeTab = lastTab;

  document.querySelectorAll('.sb-tab').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  $('btn-close').addEventListener('click', closeSidebar);
  $('btn-new').addEventListener('click', () => openManager(null));

  $('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderList();
  });

  // Sprint 4 — license banner: observa chrome.storage e repinta
  // o banner + atualiza botões sempre que o state muda.
  const banner = $('license-banner');
  subscribeLicenseState((lic) => {
    state.license = lic;
    renderBannerInto(banner, lic);
    updateSendButtons();
  });

  setActiveTab(state.activeTab);
  updateChatLabel();
  updateActivityBadge();

  callParent('ZF_QUERY_CHAT_STATE', {}).catch(() => {});

  // Sprint 5+ — QuickSearch: warm cache do índice no content.js
  // pra busca rápida por "/" no input do WA Web ser instantânea.
  setupQuickSearchSync();
}

// ============================================================
// Sprint 5+ — QuickSearch sync (content.js → sidebar)
// ============================================================
// Content.js (em web.whatsapp.com) NÃO tem acesso ao IndexedDB
// da extensão (origin diferente). A sidebar (iframe chrome-ext://)
// tem. Então sidebar é a fonte do índice e content.js consome via
// postMessage. Cache no content + refresh on-demand quando overlay
// abre garante latência ~10ms.
async function broadcastQuickSearchIndex() {
  try {
    const items = await listItems();
    const funnels = await listFunnels();
    // Apenas metadata (id, title/name, type) — sem blobs nem campos
    // pesados. Suficiente pra render do overlay.
    const itemsMeta = items.map((i) => ({
      id: i.id, title: i.title, type: i.type,
    }));
    const funnelsMeta = funnels.map((f) => ({
      id: f.id, name: f.name, stepsCount: (f.steps || []).length,
    }));
    window.parent.postMessage({
      type: 'ZF_QS_INDEX_PUSH',
      items: itemsMeta,
      funnels: funnelsMeta,
    }, '*');
  } catch (err) {
    console.warn('[Zapfire][sidebar] broadcastQuickSearchIndex falhou:', err);
  }
}

function setupQuickSearchSync() {
  // Sync inicial pra warm cache
  broadcastQuickSearchIndex();
  // Listener pra requests on-demand do content.js (quando overlay abre)
  window.addEventListener('message', (event) => {
    if (event.source === window) return;
    const msg = event.data;
    if (msg?.type === 'ZF_QS_INDEX_REQUEST') {
      broadcastQuickSearchIndex();
    }
    // Despacho de envio vindo do content (overlay → sidebar → injected)
    if (msg?.type === 'ZF_QS_SEND_ITEM') {
      handleQuickSearchSendItem(msg.itemId, msg.jid).catch((err) => {
        console.warn('[Zapfire][sidebar] QS send item falhou:', err);
      });
    }
    if (msg?.type === 'ZF_QS_RUN_FUNNEL') {
      handleQuickSearchRunFunnel(msg.funnelId).catch((err) => {
        console.warn('[Zapfire][sidebar] QS run funnel falhou:', err);
      });
    }
  });
}

// QS pediu envio direto de item (texto/áudio/mídia/arquivo) — pega
// o item completo do storage (com blob) e despacha via callParent
// usando os mesmos types do envio avulso (mesma rota dos chips da
// quickbar, mesma rota do anchored sender dos funis).
async function handleQuickSearchSendItem(itemId, jid) {
  if (!canSend(state.license)) {
    globalToast('Assinatura indisponível — renove pra enviar', 'error');
    return;
  }
  const item = await getItem(itemId);
  if (!item) {
    globalToast('Item não encontrado', 'error');
    return;
  }
  if (!jid) {
    globalToast('Não consegui detectar a conversa aberta', 'error');
    return;
  }

  let result;
  if (item.type === 'text') {
    result = await callParent('ZF_SEND_TEXT', { jid, text: item.content });
  } else if (item.type === 'image' || item.type === 'video' || item.type === 'file') {
    if (!(item.content instanceof Blob)) {
      result = { ok: false, error: 'mídia sem blob' };
    } else {
      result = await callParent('ZF_SEND_MEDIA', {
        jid, blob: item.content,
        caption: item.caption || '',
        mediaType: item.type,
      });
    }
  } else if (item.type === 'audio') {
    if (!(item.content instanceof Blob)) {
      result = { ok: false, error: 'áudio sem blob' };
    } else {
      result = await callParent('ZF_SEND_AUDIO', { jid, blob: item.content });
    }
  } else {
    result = { ok: false, error: `tipo desconhecido: ${item.type}` };
  }

  if (result?.ok) {
    await incrementItemUses(item.id);
    globalToast(`Enviado: ${item.title}`, 'success');
  } else {
    globalToast(`Falha: ${result?.error || 'erro desconhecido'}`, 'error');
  }
}

// QS pediu pra rodar funil — reusa o pipeline existente da sidebar
// (handleRunFunnel) porque ele cuida de tracking, indicador, etc.
// Diferença: precisamos pular o getActiveChat (já temos o chat aberto
// quando o user digitou no input).
async function handleQuickSearchRunFunnel(funnelId) {
  const funnel = await getFunnel(funnelId);
  if (!funnel) {
    globalToast('Funil não encontrado', 'error');
    return;
  }
  // handleRunFunnel já valida chat aberto e dispara — vai funcionar
  // porque o user acabou de digitar no input do chat ativo.
  handleRunFunnel(funnel);
}

init();
