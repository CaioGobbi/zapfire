// ============================================================
// ZAPFIRE — QuickBar (controller)
// ============================================================
// Iframe injetado no WA Web, logo abaixo do input de mensagem.
// Mostra TODOS os items como chips clicáveis em ordem:
//   funis → mensagens (text) → áudios → mídias (image/video/file)
//
// Sem tabs, sem busca, sem edição. Só enviar rápido.
// Pra navegação completa, o usuário abre a sidebar.
//
// Compartilha o IndexedDB com sidebar + manager (mesma origem
// chrome-extension://). Envio via callParent → content.js →
// API (WPP/nativo).
// ============================================================

import {
  listItems,
  listFunnels,
  incrementItemUses,
} from '../lib/storage.js';
import {
  subscribeLicenseState,
  renderBannerInto,
  canSend,
  isBlocked,
} from '../lib/grace-banner.js';

const $ = (id) => document.getElementById(id);

const state = {
  chatOpen: false,
  chatName: null,
  items: [],
  funnels: [],
  // Sprint 4 — license state (null = permissivo até primeiro validate)
  license: null,
};

// ------------------------------------------------------------
// Bridge com content script (parent window)
// ------------------------------------------------------------
const pendingRequests = new Map();

function callParent(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingRequests.set(requestId, { resolve, reject });
    window.parent.postMessage({ type, requestId, ...payload }, '*');
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('Timeout'));
      }
    }, 30_000);
  });
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ZF_RESPONSE' && msg.requestId) {
    const p = pendingRequests.get(msg.requestId);
    if (p) {
      pendingRequests.delete(msg.requestId);
      p.resolve(msg.result);
    }
    return;
  }

  if (msg.type === 'ZF_CHAT_STATE') {
    state.chatOpen = !!msg.isOpen;
    state.chatName = msg.chatName || null;
    updateChipStates();
    return;
  }

  // Forçar reload quando items/funis mudam em outro contexto
  if (msg.type === 'ZF_STORAGE_CHANGED') {
    loadAndRender();
    return;
  }
});

// ------------------------------------------------------------
// Toast — via bridge (content script mostra em nível viewport)
// ------------------------------------------------------------
function toast(message, type = 'info') {
  window.parent.postMessage({ type: 'ZF_TOAST', message, toastType: type }, '*');
}

// ------------------------------------------------------------
// Render
// ------------------------------------------------------------
async function loadAndRender() {
  state.funnels = await listFunnels();
  state.items = await listItems();
  render();
}

function render() {
  const list = $('list');
  list.innerHTML = '';

  // Ordem: funis → text → audio → image/video/file (mídia)
  const groups = [
    { key: 'funnels', label: 'FUNIL', items: state.funnels.map((f) => ({ ...f, _kind: 'funnel' })) },
    { key: 'text',    label: 'MSG',   items: state.items.filter((i) => i.type === 'text') },
    { key: 'audio',   label: 'ÁUDIO', items: state.items.filter((i) => i.type === 'audio') },
    { key: 'media',   label: 'MÍDIA', items: state.items.filter((i) => i.type === 'image' || i.type === 'video' || i.type === 'file') },
  ];

  let total = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (!g.items.length) continue;

    // Separador entre grupos (não antes do primeiro renderizado)
    if (total > 0) {
      const sep = document.createElement('div');
      sep.className = 'chip-divider';
      list.appendChild(sep);
    }

    for (const item of g.items) {
      list.appendChild(chipFor(item, g.label, g.key));
      total++;
    }
  }

  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'qb-empty';
    empty.textContent = 'Sem items. Abra o gerenciador pra criar.';
    list.appendChild(empty);
  }

  updateChipStates();
}

// SVG icons por tipo (Lucide-style, 12px)
const CHIP_ICONS = {
  funnel: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
  text:   '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  audio:  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  media:  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
};

function chipFor(item, badge, groupKey) {
  const colorKey =
    groupKey === 'funnels' ? 'funnel' :
    groupKey === 'text' ? 'text' :
    groupKey === 'audio' ? 'audio' :
    'media';

  const btn = document.createElement('button');
  btn.className = `chip chip--${colorKey}`;
  btn.title = (item.name || item.title || '') + (item.content && typeof item.content === 'string'
    ? '\n\n' + item.content.slice(0, 200) : '');

  const icon = document.createElement('span');
  icon.className = 'chip-icon';
  icon.innerHTML = CHIP_ICONS[colorKey] || '';
  btn.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = item.name || item.title || '(sem nome)';
  btn.appendChild(label);

  btn.dataset.kind = groupKey;
  btn.dataset.id = item.id;
  btn.onclick = () => handleClick(item, groupKey);

  return btn;
}

function updateChipStates() {
  const blocked = isBlocked(state.license);
  const enabled = state.chatOpen && !blocked;
  document.querySelectorAll('.chip').forEach((btn) => {
    btn.disabled = !enabled;
    if (blocked) {
      btn.title = 'Envios bloqueados — renove sua assinatura';
    } else {
      btn.title = state.chatOpen
        ? btn.title.split('\n\n')[0]
        : 'Abra uma conversa primeiro';
    }
  });
}

// ------------------------------------------------------------
// Envio
// ------------------------------------------------------------
async function handleClick(item, kind) {
  // Gate de licença (Sprint 4 ETAPA 7)
  if (!canSend(state.license)) {
    toast('Assinatura indisponível — renove pra continuar', 'error');
    return;
  }
  if (!state.chatOpen) {
    toast('Abra uma conversa primeiro', 'warning');
    return;
  }

  // Captura JID do chat aberto
  let jid = null;
  try {
    const idRes = await callParent('ZF_GET_CHAT_ID');
    if (idRes?.ok && idRes.target?.jid) jid = idRes.target.jid;
  } catch (_) {}

  if (kind === 'funnels') {
    // Delega o run pra sidebar (ela gerencia a Map de activeRuns
    // e renderiza o progresso na tab Ativos)
    toast(`Iniciando funil: ${item.name}`, 'info');
    await callParent('ZF_QB_RUN_FUNNEL', { funnelId: item.id });
    return;
  }

  // Envio direto de item
  toast('Enviando...', 'info');
  try {
    let msgType, payload;
    if (item.type === 'text') {
      msgType = 'ZF_SEND_TEXT';
      payload = { jid, text: item.content };
    } else if (item.type === 'audio') {
      if (!(item.content instanceof Blob)) {
        toast('Áudio sem blob', 'error');
        return;
      }
      msgType = 'ZF_SEND_AUDIO';
      payload = { jid, blob: item.content };
    } else if (item.type === 'image' || item.type === 'video' || item.type === 'file') {
      if (!(item.content instanceof Blob)) {
        toast('Mídia sem blob', 'error');
        return;
      }
      msgType = 'ZF_SEND_MEDIA';
      payload = { jid, blob: item.content, caption: item.caption || '', mediaType: item.type };
    } else {
      toast('Tipo desconhecido', 'error');
      return;
    }

    const result = await callParent(msgType, payload);
    if (result.ok) {
      await incrementItemUses(item.id);
      toast('Enviado', 'success');
    } else {
      toast(result.error || 'Falha', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ------------------------------------------------------------
// License state (Sprint 4) — observa chrome.storage e:
//   - blocked: mostra banner compacto + esconde chips
//   - grace: sem banner no quickbar (espaço apertado; banner
//           aparece na sidebar/popup). Chips continuam ativos.
//   - ok/null: tudo normal
// ------------------------------------------------------------
function applyLicenseUI(lic) {
  const banner = document.getElementById('license-banner');
  const qb = document.querySelector('.qb');
  if (isBlocked(lic)) {
    renderBannerInto(banner, lic, { compact: true });
    qb?.classList.add('qb--blocked');
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
    qb?.classList.remove('qb--blocked');
  }
  updateChipStates();
}

// ------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------
(async () => {
  await loadAndRender();
  subscribeLicenseState((lic) => {
    state.license = lic;
    applyLicenseUI(lic);
  });
  callParent('ZF_QUERY_CHAT_STATE', {}).catch(() => {});
})();
