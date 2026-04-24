// ============================================================
// ZAPFIRE — Content Script
// ============================================================
// Injetado em https://web.whatsapp.com/*
//
// Responsabilidades:
// 1. Esperar o WhatsApp Web carregar completamente
// 2. Extrair o número do usuário logado
// 3. Validar com o backend via service worker
// 4. Montar a sidebar (iframe da extensão) quando autenticado
// 5. Servir de bridge entre o iframe (sidebar) e o DOM do WA
//    (chamando o sender.js pra enviar mensagens)
//
// Por que iframe?
//   A sidebar precisa ler/escrever o IndexedDB compartilhado
//   com o manager. Pra isso ela tem que rodar na origem da
//   extensão (chrome-extension://). Iframe resolve isso de
//   forma limpa, e usamos postMessage pra ponte.
// ============================================================

const WAIT_FOR_LOAD_TIMEOUT = 60_000; // 60s

// ------------------------------------------------------------
// 1. Espera o WA Web terminar de carregar
// ------------------------------------------------------------
async function waitForWhatsAppReady() {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const pane = document.querySelector('#pane-side');
      if (pane) return resolve(true);

      if (Date.now() - start > WAIT_FOR_LOAD_TIMEOUT) {
        return reject(new Error('Timeout esperando WA Web carregar'));
      }
      setTimeout(check, 500);
    };
    check();
  });
}

// ------------------------------------------------------------
// 2. Extrai o número do WhatsApp logado
// ------------------------------------------------------------
async function getUserPhone() {
  // --- Método principal: last-wid-md ---
  try {
    const raw = localStorage.getItem('last-wid-md');
    if (raw) {
      const clean = raw.replace(/"/g, '').split('@')[0].split(':')[0];
      if (/^\d{10,15}$/.test(clean)) {
        return clean;
      }
    }
  } catch (e) {
    console.warn('[Zapfire] Falha no método principal:', e);
  }

  // --- Fallback: varre todas as chaves do localStorage ---
  try {
    for (const key of Object.keys(localStorage)) {
      const val = localStorage.getItem(key);
      if (val && val.includes('@c.us')) {
        const match = val.match(/(\d{10,15})(?::\d+)?@c\.us/);
        if (match && match[1]) return match[1];
      }
    }
  } catch (e) {}

  return null;
}

// ------------------------------------------------------------
// 3. Fluxo principal — roda quando a página carrega
// ------------------------------------------------------------
async function init() {
  try {
    await waitForWhatsAppReady();
    await new Promise((r) => setTimeout(r, 2000));

    const phone = await getUserPhone();
    if (!phone) {
      console.warn('[Zapfire] Não conseguiu extrair o número');
      return;
    }

    const { isAuthenticated } = await chrome.runtime.sendMessage({
      type: 'ZF_GET_AUTH_STATE',
    });

    if (!isAuthenticated) {
      showBanner({
        title: 'Zapfire não ativado',
        message: 'Clique no ícone da extensão e cole sua chave de acesso.',
        type: 'warning',
      });
      return;
    }

    const stored = await chrome.storage.local.get('zf_key');
    const result = await chrome.runtime.sendMessage({
      type: 'ZF_VALIDATE',
      payload: { keyValue: stored.zf_key, phone },
    });

    // Sprint 4 ETAPA 7 — estados recuperáveis pelo painel (grace/blocked
    // pós-grace, número errado, chave bloqueada) montam a sidebar assim
    // mesmo: o banner vermelho dentro dela já orienta o user pro painel
    // com botão "Renovar". Só erros destrutivos (chave deletada no
    // backend, rede caiu) caem no banner fixo de topo sem UI.
    const RECOVERABLE_BLOCK_CODES = new Set(['EXPIRED', 'WRONG_PHONE', 'BLOCKED']);
    if (!result.ok) {
      if (RECOVERABLE_BLOCK_CODES.has(result.code)) {
        console.log('[Zapfire] Subscrição bloqueada (' + result.code + ') — montando sidebar pro banner de renovação');
        mountSidebar();
        return;
      }
      showBanner({
        title: 'Zapfire bloqueado',
        message: result.message,
        type: 'error',
      });
      return;
    }

    console.log('[Zapfire] Ativo para', phone, '— plano', result.data.plan.name);
    mountSidebar();
  } catch (err) {
    console.error('[Zapfire] Falhou ao inicializar:', err);
  }
}

// ------------------------------------------------------------
// Banner simples de status (topo da tela) — só pra erros/aviso
// ------------------------------------------------------------
function showBanner({ title, message, type = 'info' }) {
  const existing = document.getElementById('zapfire-banner');
  if (existing) existing.remove();

  const colors = {
    info: '#1a1a1a',
    warning: '#ff6b00',
    error: '#dc2626',
    success: '#16a34a',
  };

  const banner = document.createElement('div');
  banner.id = 'zapfire-banner';
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
    background: ${colors[type]}; color: white; padding: 12px 24px;
    font-family: -apple-system, sans-serif; font-size: 14px;
    display: flex; align-items: center; gap: 12px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;
  banner.innerHTML = `
    <strong>${title}</strong>
    <span style="opacity:0.9">${message}</span>
    <button style="margin-left:auto; background:transparent; border:1px solid white; color:white; padding:4px 12px; border-radius:4px; cursor:pointer;">×</button>
  `;
  banner.querySelector('button').onclick = () => banner.remove();
  document.body.appendChild(banner);
}

// ============================================================
// SIDEBAR — iframe + toggle + bridge
// ============================================================

const SIDEBAR_IFRAME_ID = 'zapfire-sidebar-iframe';
const SIDEBAR_TOGGLE_ID = 'zapfire-toggle';
const QUICKBAR_IFRAME_ID = 'zapfire-quickbar-iframe';
const QUICKBAR_HEIGHT = 44;

let sidebarIframe = null;
let quickbarIframe = null;
let toggleBtn = null;
let sidebarOpen = false;
let lastChatStateKey = null; // pra deduplicar broadcasts

function mountSidebar() {
  if (document.getElementById(SIDEBAR_IFRAME_ID)) return;

  // ---- Iframe ----
  sidebarIframe = document.createElement('iframe');
  sidebarIframe.id = SIDEBAR_IFRAME_ID;
  sidebarIframe.src = chrome.runtime.getURL('sidebar/sidebar.html');
  sidebarIframe.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: 320px;
    height: 100vh;
    border: none;
    z-index: 2147483646;
    background: #0a0a0a;
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
    transform: translateX(100%);
    transition: transform 0.2s ease-out;
    color-scheme: dark;
  `;
  document.body.appendChild(sidebarIframe);

  // ---- Toggle button ----
  toggleBtn = document.createElement('button');
  toggleBtn.id = SIDEBAR_TOGGLE_ID;
  toggleBtn.textContent = 'Z';
  toggleBtn.title = 'Abrir Zapfire';
  toggleBtn.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 160px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #ff3b30;
    color: white;
    border: none;
    font-weight: 900;
    font-size: 18px;
    cursor: pointer;
    z-index: 2147483645;
    box-shadow: 0 4px 16px rgba(255, 59, 48, 0.4);
    font-family: -apple-system, sans-serif;
  `;
  toggleBtn.onclick = () => setSidebarOpen(true);
  document.body.appendChild(toggleBtn);

  // ---- QuickBar (barra horizontal abaixo do input do WA) ----
  mountQuickbar();

  // ---- Bridge ----
  window.addEventListener('message', handleIframeMessage);

  // Polling do estado do chat (a cada 1.5s) — barato e suficiente
  startChatStatePolling();
}

// Insere o iframe da quickbar DENTRO do <footer> do WA (o
// elemento que já tem o input de mensagem). Assim o footer
// cresce naturalmente pra comportar os dois — o input fica em
// cima, a quickbar em baixo, tudo fluindo no layout nativo
// sem risco de overflow:hidden do #main.
//
// Como WA recria esses elementos ao trocar de conversa ou
// quando desconecta, usamos MutationObserver pra re-inserir
// quando necessário.
function mountQuickbar() {
  ensureQuickbarInFooter();

  const observer = new MutationObserver(() => {
    ensureQuickbarInFooter();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ------------------------------------------------------------
// Toast no nível do viewport (chamado por iframes via ZF_TOAST)
// ------------------------------------------------------------
function showContentToast(message, type = 'info') {
  const colors = {
    info: '#ff3b30',
    success: '#10b981',
    error: '#dc2626',
    warning: '#ff6b00',
  };
  let el = document.getElementById('zf-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'zf-toast';
    el.style.cssText = `
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: #141414;
      color: white;
      padding: 10px 16px;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      z-index: 2147483647;
      border: 1px solid #262626;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      transition: opacity 0.2s;
      pointer-events: none;
      max-width: 420px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    document.body.appendChild(el);
  }
  el.textContent = message || '';
  el.style.borderColor = colors[type] || colors.info;
  el.style.opacity = '1';
  clearTimeout(el._zfHideTimer);
  el._zfHideTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ------------------------------------------------------------
// Indicador piscante pra chats com funil ativo
// ------------------------------------------------------------
// Sidebar envia ZF_ACTIVE_RUNS_CHANGED com a lista de JIDs que
// têm funis rodando. Content script guarda, e durante o polling
// de estado do chat verifica se o chat aberto bate. Se sim,
// exibe um ícone pulsante flutuando sobre o #main.
// ------------------------------------------------------------
const activeRunJids = new Set();
let indicatorEl = null;
let indicatorStyleInjected = false;
let lastKnownCurrentJid = null;

function setActiveRunJids(jids) {
  activeRunJids.clear();
  for (const jid of jids) if (jid) activeRunJids.add(jid);
  console.log('[Zapfire][content] active run JIDs:', Array.from(activeRunJids));
  updateFunnelIndicator();
}

function ensureIndicatorStyle() {
  if (indicatorStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes zf-indicator-pulse {
      0%, 100% {
        transform: scale(1);
        box-shadow: 0 0 0 0 rgba(255, 59, 48, 0.55);
      }
      50% {
        transform: scale(1.08);
        box-shadow: 0 0 0 14px rgba(255, 59, 48, 0);
      }
    }
    #zf-funnel-indicator {
      position: fixed;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #ff3b30;
      display: grid;
      place-items: center;
      color: white;
      font-size: 15px;
      font-weight: 900;
      letter-spacing: -0.02em;
      z-index: 2147483640;
      cursor: pointer;
      animation: zf-indicator-pulse 1.4s infinite;
      box-shadow: 0 4px 12px rgba(255, 59, 48, 0.35);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      border: 2px solid #141414;
      user-select: none;
    }
  `;
  document.head.appendChild(style);
  indicatorStyleInjected = true;
}

async function updateFunnelIndicator() {
  // Captura JID do chat atual via WPP (fonte de verdade — mesma
  // usada pela sidebar). Fallback pro DOM se WPP falhar.
  let currentJid = null;
  try {
    const res = await callInjectedApi('ZF_API_GET_ACTIVE_CHAT', {}, 1500);
    if (res?.ok && res.target?.jid) currentJid = res.target.jid;
  } catch (_) {}
  if (!currentJid) currentJid = getActiveChatJid();
  lastKnownCurrentJid = currentJid;

  const hasMatch = currentJid && activeRunJids.has(currentJid);

  console.log('[Zapfire][content] indicator check:', {
    currentJid,
    activeRuns: Array.from(activeRunJids),
    hasMatch,
  });

  if (!hasMatch) {
    if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
    return;
  }

  ensureIndicatorStyle();

  if (!indicatorEl) {
    indicatorEl = document.createElement('div');
    indicatorEl.id = 'zf-funnel-indicator';
    indicatorEl.title = 'Funil em execução nesta conversa (clique pra ver detalhes)';
    indicatorEl.textContent = 'Z';
    indicatorEl.onclick = () => {
      setSidebarOpen(true);
      if (sidebarIframe) {
        sidebarIframe.contentWindow.postMessage({ type: 'ZF_FOCUS_ACTIVITY' }, '*');
      }
    };
    document.body.appendChild(indicatorEl);
  }

  // Posiciona sobre o topo-esquerdo do #main (área da conversa)
  const main = document.querySelector('#main');
  if (main) {
    const rect = main.getBoundingClientRect();
    indicatorEl.style.top = `${rect.top + 70}px`;
    indicatorEl.style.left = `${rect.left + 18}px`;
  }
}

// ------------------------------------------------------------
// Confirm modal centralizado no viewport
// ------------------------------------------------------------
function showConfirmDialog(message, confirmLabel = 'Sim', cancelLabel = 'Não') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'zf-confirm-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(2px);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      animation: zfFadeIn 0.15s ease-out;
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes zfFadeIn { from { opacity: 0; } to { opacity: 1; } }
      #zf-confirm-overlay button { font-family: inherit; cursor: pointer; }
      #zf-confirm-overlay button:focus { outline: 2px solid #ff3b30; outline-offset: 1px; }
    `;
    overlay.appendChild(style);

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #141414;
      color: #f5f5f5;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 24px;
      width: min(400px, calc(100vw - 40px));
      box-shadow: 0 20px 60px rgba(0,0,0,0.7);
    `;

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size: 14px; line-height: 1.5; margin-bottom: 20px; color: #f5f5f5;';
    msg.textContent = message;
    dialog.appendChild(msg);

    const actions = document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

    const btnNo = document.createElement('button');
    btnNo.textContent = cancelLabel;
    btnNo.style.cssText = `
      background: transparent;
      color: #a3a3a3;
      border: 1px solid #262626;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
    `;

    const btnYes = document.createElement('button');
    btnYes.textContent = confirmLabel;
    btnYes.style.cssText = `
      background: #ff3b30;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
    `;

    actions.appendChild(btnNo);
    actions.appendChild(btnYes);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    const cleanup = (result) => {
      try { overlay.remove(); } catch (_) {}
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    };

    btnYes.onclick = () => cleanup(true);
    btnNo.onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    setTimeout(() => btnYes.focus(), 50);
  });
}

function ensureQuickbarInFooter() {
  // O footer do #main contém o input "Digite uma mensagem"
  const footer = document.querySelector('#main footer');
  if (!footer) return;

  // Já está lá? OK.
  const existing = document.getElementById(QUICKBAR_IFRAME_ID);
  if (existing && existing.parentElement === footer) return;

  // Estava em outro lugar → remove
  if (existing) existing.remove();

  const iframe = document.createElement('iframe');
  iframe.id = QUICKBAR_IFRAME_ID;
  iframe.src = chrome.runtime.getURL('quickbar/quickbar.html');
  iframe.style.cssText = `
    display: block;
    width: 100%;
    height: ${QUICKBAR_HEIGHT}px;
    border: none;
    background: #0a0a0a;
    color-scheme: dark;
    flex-shrink: 0;
  `;
  footer.appendChild(iframe);
  quickbarIframe = iframe;
}

const SIDEBAR_WIDTH = 320;

function setSidebarOpen(open) {
  sidebarOpen = open;
  if (sidebarIframe) {
    sidebarIframe.style.transform = open ? 'translateX(0)' : 'translateX(100%)';
  }
  if (toggleBtn) {
    toggleBtn.style.display = open ? 'none' : 'block';
  }
  // Quickbar está dentro do #main — reflui automaticamente com o
  // layout shift do body/app
  applyLayoutShift(open);
}

// Empurra o conteúdo do WA pra esquerda quando a sidebar abre.
// O iframe é position:fixed então ignora padding/margin do body
// e fica fixo no canto direito. Pra fazer o conteúdo do WA
// reflowar, setamos width tanto no <body> quanto no #app — WA
// Web usa width:100vw/100% nos containers internos, então mexer
// só no html não funciona.
function applyLayoutShift(open) {
  const targetWidth = open ? `calc(100vw - ${SIDEBAR_WIDTH}px)` : '';
  const targets = [document.body, document.getElementById('app')].filter(Boolean);

  for (const el of targets) {
    if (!el.dataset.zfShiftReady) {
      el.style.transition = 'width 0.2s ease-out';
      el.dataset.zfShiftReady = '1';
    }
    el.style.width = targetWidth;
    // Alguns elementos internos usam min-width — força também
    el.style.minWidth = targetWidth;
  }
}

// ------------------------------------------------------------
// Bridge — recebe mensagens do iframe sidebar OU quickbar
// ------------------------------------------------------------
async function handleIframeMessage(event) {
  // Validação: só aceita de iframes nossos (sidebar ou quickbar)
  const isSidebar = sidebarIframe && event.source === sidebarIframe.contentWindow;
  const isQuickbar = quickbarIframe && event.source === quickbarIframe.contentWindow;
  if (!isSidebar && !isQuickbar) return;

  const msg = event.data;
  if (!msg || typeof msg !== 'object' || !msg.type) return;

  // Responde pro iframe correto que mandou a msg
  const respond = (result) => {
    event.source.postMessage(
      { type: 'ZF_RESPONSE', requestId: msg.requestId, result },
      '*'
    );
  };

  switch (msg.type) {
    case 'ZF_CLOSE_SIDEBAR':
      setSidebarOpen(false);
      return;

    case 'ZF_TOAST':
      showContentToast(msg.message, msg.toastType);
      return;

    case 'ZF_CONFIRM': {
      const ok = await showConfirmDialog(msg.message || 'Confirmar?', msg.confirmLabel, msg.cancelLabel);
      respond({ ok });
      return;
    }

    case 'ZF_ACTIVE_RUNS_CHANGED':
      setActiveRunJids(msg.jids || []);
      return;

    case 'ZF_OPEN_MANAGER':
      chrome.runtime.sendMessage({
        type: 'ZF_OPEN_MANAGER',
        focus: msg.focus || null,
      }).catch(() => {});
      respond({ ok: true });
      return;

    // QuickBar pede pra sidebar executar um funil. Forwarda pro
    // iframe da sidebar (que gerencia o Map de activeRuns e
    // renderiza o progresso na tab Ativos).
    case 'ZF_QB_RUN_FUNNEL':
      if (sidebarIframe) {
        sidebarIframe.contentWindow.postMessage(
          { type: 'ZF_RUN_FUNNEL_FROM_QB', funnelId: msg.funnelId },
          '*'
        );
      }
      respond({ ok: true });
      return;

    case 'ZF_QUERY_CHAT_STATE':
      respond(getChatState());
      // Também envia broadcast pra alinhar a UI (pros dois iframes)
      broadcastChatState(true);
      return;

    case 'ZF_GET_CHAT_ID': {
      // Primeiro tenta via WPP (retorna JID real do chat aberto).
      // Fallback: DOM (pode falhar em conversas novas sem data-id).
      try {
        const wppRes = await callInjectedApi('ZF_API_GET_ACTIVE_CHAT', {}, 5000);
        if (wppRes?.ok && wppRes.target?.jid) {
          respond(wppRes);
          return;
        }
      } catch (_) {}

      const domId = getChatIdentifier();
      respond(domId ? { ok: true, target: domId } : { ok: false, error: 'Nenhuma conversa aberta' });
      return;
    }

    case 'ZF_SWITCH_CHAT': {
      const result = await switchToChat(msg.target);
      respond(result);
      return;
    }

    case 'ZF_SEND_TEXT': {
      try {
        let result;
        if (msg.jid) {
          result = await callInjectedApi('ZF_API_SEND_TEXT', {
            jid: msg.jid,
            text: msg.text,
          });
        } else {
          const sender = await loadSender();
          result = await sender.sendText(msg.text);
        }
        respond(result);
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
      return;
    }

    case 'ZF_SEND_MEDIA': {
      try {
        let result;
        if (msg.jid) {
          const wppType =
            msg.mediaType === 'file' ? 'document' :
            msg.mediaType === 'image' ? 'image' :
            msg.mediaType === 'video' ? 'video' :
            'auto';
          result = await callInjectedApi('ZF_API_SEND_FILE', {
            jid: msg.jid,
            blob: msg.blob,
            fileType: wppType,
            caption: msg.caption || '',
          }, 60_000);
        } else {
          const sender = await loadSender();
          result = await sender.sendMedia(
            msg.blob,
            msg.caption || '',
            msg.mediaType || 'file'
          );
        }
        respond(result);
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
      return;
    }

    case 'ZF_SEND_AUDIO': {
      try {
        let result;
        if (msg.jid) {
          result = await callInjectedApi('ZF_API_SEND_FILE', {
            jid: msg.jid,
            blob: msg.blob,
            fileType: 'audio',
            isPtt: true,
          }, 60_000);
        } else {
          const sender = await loadSender();
          result = await sender.sendAudioAsVoice(msg.blob);
        }
        respond(result);
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
      return;
    }

    case 'ZF_RUN_FUNNEL':
      respond({ ok: false, error: 'ZF_RUN_FUNNEL não usado (runs iniciam na sidebar)' });
      return;
  }
}

// ------------------------------------------------------------
// Bridge → injected (MAIN world) via window.postMessage
// ------------------------------------------------------------
// Content script (isolated) e injected (main) compartilham o
// window object. postMessage chega nos dois mundos, filtra por
// __zf_source.
// ------------------------------------------------------------
function callInjectedApi(apiType, payload = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();

    const handler = (event) => {
      if (event.source !== window) return;
      const m = event.data;
      if (!m || m.__zf_source !== 'injected') return;
      if (m.type !== 'ZF_API_RESPONSE' || m.requestId !== requestId) return;

      window.removeEventListener('message', handler);
      clearTimeout(timer);
      resolve(m.result);
    };

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('injected API timeout (' + apiType + ')'));
    }, timeoutMs);

    window.addEventListener('message', handler);
    window.postMessage({
      __zf_source: 'content',
      type: apiType,
      requestId,
      ...payload,
    }, '*');
  });
}

// ------------------------------------------------------------
// Carregamento dinâmico do sender (lib/sender.js é ES module)
// ------------------------------------------------------------
let _senderPromise = null;
function loadSender() {
  if (!_senderPromise) {
    _senderPromise = import(chrome.runtime.getURL('lib/sender.js'));
  }
  return _senderPromise;
}

// ------------------------------------------------------------
// Estado do chat — polling barato pra avisar a sidebar
// ------------------------------------------------------------
// Cascata de seletores pro nome do chat. WA Web muda esses nomes
// frequentemente — manter genérico e tolerante.
const CHAT_NAME_SELECTORS = [
  '#main header [data-testid="conversation-info-header-chat-title"]',
  '#main header span[dir="auto"][title]',
  '#main header span[title]',
  '#main header div[role="button"] span[dir="auto"]',
  '#main header span[dir="auto"]',
];

function findChatNameEl() {
  for (const sel of CHAT_NAME_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.getAttribute('title') || el.textContent || '').trim();
      if (text) return text;
    }
  }
  return null;
}

function getChatState() {
  // Replica os seletores do sender (sem importar pra evitar
  // delay de import dinâmico em loop)
  const input =
    document.querySelector('footer div[contenteditable="true"][data-tab="10"]') ||
    document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
    document.querySelector('footer div[contenteditable="true"]');

  const chatName = input ? findChatNameEl() : null;
  return { isOpen: !!input, chatName };
}

// ------------------------------------------------------------
// Identificação e navegação de conversas (pra ancorar funis)
// ------------------------------------------------------------
//
// Funis precisam continuar enviando pra conversa de ORIGEM
// mesmo se o usuário trocar de chat. Pra isso capturamos um
// "identificador" da conversa quando o funil começa, e antes
// de cada send pulamos de volta pra ela.
//
// O identificador ideal é o JID do WhatsApp (ex:
// "5511999999999@c.us"), que aparece em data-id na lista
// lateral. Se não acharmos JID, caímos no nome do contato
// (ambíguo se houver dois contatos com mesmo nome, mas
// suficiente pra MVP).
// ------------------------------------------------------------

// Extrai o número de telefone do JID (pra individual chats)
function jidPhone(jid) {
  if (!jid) return null;
  const m = String(jid).match(/(\d{10,15})/);
  return m ? m[1] : null;
}

// Remove o prefixo "true_" / "false_" do data-id do WA
// e valida formato. Cobre @c.us (individuais), @g.us (grupos),
// @lid (linked IDs do Meta), @broadcast.
function cleanJid(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/^(true|false)_/, '');
  if (/^[\d\-_]+@[\w.]+$/.test(stripped)) return stripped;
  return null;
}

// Tenta extrair o JID da conversa aberta — prefere data-id da
// linha selecionada, com fallback pro #main.
function getActiveChatJid() {
  // 1) Row selecionado na lista lateral
  const selSelectors = [
    '#pane-side [aria-selected="true"]',
    '#pane-side [role="row"][aria-selected="true"]',
    '#pane-side [aria-current="page"]',
  ];
  for (const sel of selSelectors) {
    const row = document.querySelector(sel);
    if (!row) continue;
    let el = row;
    while (el && !el.getAttribute?.('data-id')) el = el.parentElement;
    if (el) {
      const clean = cleanJid(el.getAttribute('data-id'));
      if (clean) return clean;
    }
    const child = row.querySelector('[data-id]');
    if (child) {
      const clean = cleanJid(child.getAttribute('data-id'));
      if (clean) return clean;
    }
  }

  // 2) Fallback: busca qualquer data-id dentro de #main
  const main = document.querySelector('#main');
  if (main) {
    const dataIdEls = main.querySelectorAll('[data-id]');
    for (const el of dataIdEls) {
      const clean = cleanJid(el.getAttribute('data-id'));
      if (clean) return clean;
    }
  }

  return null;
}

function getChatIdentifier() {
  const name = findChatNameEl();
  if (!name) return null;
  const jid = getActiveChatJid();
  return { name, jid, phone: jidPhone(jid) };
}

// Compara identidades — usa phone como chave principal (estável),
// nome como fallback (ambíguo mas suficiente)
function chatMatches(target, current) {
  if (!current) return false;
  if (target.phone && current.phone) return target.phone === current.phone;
  if (target.jid && current.jid) return target.jid === current.jid;
  return target.name === current.name;
}

// Espera a conversa atual virar o target (com timeout)
async function waitForChatToBe(target, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (chatMatches(target, getChatIdentifier())) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

// ------------------------------------------------------------
// switchToChat — VERSÃO MINIMAL (Sprint 3.5 vai substituir)
// ------------------------------------------------------------
// WA Web bloqueia totalmente switching programático via DOM/eventos:
//   - Clicks sintéticos: bloqueados (isTrusted check)
//   - React internals: escondidos (sem __reactFiber/__reactProps)
//   - Search programático: filtra mas resultado não clica
//   - Keyboard nav: também sintético, bloqueado
//
// Solução real está no Sprint 3.5 — Internal API Integration via
// Store hijacking (acessar webpack do WA e chamar Store.SendMsg
// direto, sem precisar abrir o chat).
//
// Por enquanto: switchToChat só verifica se o chat ALVO já está
// aberto. Se sim, retorna ok. Se não, retorna erro — o sender
// na sidebar fica em loop esperando o usuário abrir.
// ------------------------------------------------------------
async function switchToChat(target) {
  if (!target || !target.name) {
    return { ok: false, error: 'Target inválido' };
  }
  if (chatMatches(target, getChatIdentifier())) {
    return { ok: true, alreadyOpen: true };
  }
  return {
    ok: false,
    error: `Conversa "${target.name}" não está aberta`,
  };
}

function broadcastChatState(force = false) {
  const s = getChatState();
  const key = `${s.isOpen}|${s.chatName || ''}`;
  if (!force && key === lastChatStateKey) {
    // Mesmo sem mudar o nome, reposiciona o indicador (layout pode
    // ter mudado por resize de janela, abertura de sidebar, etc)
    updateFunnelIndicator();
    return;
  }
  lastChatStateKey = key;
  // Broadcast pros dois iframes (sidebar + quickbar)
  for (const ifr of [sidebarIframe, quickbarIframe]) {
    if (ifr && ifr.contentWindow) {
      ifr.contentWindow.postMessage({ type: 'ZF_CHAT_STATE', ...s }, '*');
    }
  }
  // Atualiza visibilidade do indicador de funil (ancora no chat atual)
  updateFunnelIndicator();
}

function startChatStatePolling() {
  setInterval(() => broadcastChatState(false), 1500);
}

// ------------------------------------------------------------
// Escuta invalidações do service worker
// ------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ZF_AUTH_INVALIDATED') {
    showBanner({
      title: 'Sessão expirada',
      message: 'Sua chave foi invalidada. Faça login novamente.',
      type: 'error',
    });
    // Esconde sidebar + quickbar + indicador e desfaz os shifts
    if (sidebarIframe) { sidebarIframe.remove(); sidebarIframe = null; }
    if (quickbarIframe) { quickbarIframe.remove(); quickbarIframe = null; }
    if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
    activeRunJids.clear();
    if (toggleBtn) toggleBtn.remove();
    for (const el of [document.body, document.getElementById('app')]) {
      if (el) {
        el.style.width = '';
        el.style.minWidth = '';
      }
    }
  }
});

// Bootstrap
init();
