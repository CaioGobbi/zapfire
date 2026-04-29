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

    // Sprint 5 ETAPA C — se o SW agendou um daily report enquanto o
    // WA Web estava fechado, processa agora. Best-effort: erro só loga.
    processPendingReportIfAny().catch(() => {});
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
const QUICKBAR_HEIGHT = 48;

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

// ResizeObserver no #main (instanciado uma vez, reusado) +
// listeners de resize/scroll do window. Garante que o indicador
// fica colado ao topo-esquerdo do #main mesmo quando o WA muda
// layout (resize da janela, side-panel abrindo, modo compacto).
let mainResizeObserver = null;
let indicatorReposListenersAttached = false;

function attachIndicatorRepositionListeners() {
  if (indicatorReposListenersAttached) return;
  indicatorReposListenersAttached = true;

  // Window resize cobre redimensionamento do browser
  window.addEventListener('resize', repositionIndicator);
  // Scroll do window é raro mas cobre edge cases
  window.addEventListener('scroll', repositionIndicator, true);
}

function ensureMainResizeObserver(main) {
  if (!main || mainResizeObserver) return;
  // ResizeObserver dispara quando #main muda de tamanho — cobre
  // sidebar do WA aparecendo/sumindo, drawer de info abrindo, etc
  mainResizeObserver = new ResizeObserver(() => {
    repositionIndicator();
  });
  try { mainResizeObserver.observe(main); } catch (_) {}
}

// Reposiciona o indicador colado no topo-esquerdo do #main.
// Inclui boundary check: se #main não existe ou está fora do viewport
// (raro mas possível), esconde em vez de deixar coordenada inválida.
function repositionIndicator() {
  if (!indicatorEl) return;
  const main = document.querySelector('#main');
  if (!main) {
    indicatorEl.style.display = 'none';
    return;
  }
  const rect = main.getBoundingClientRect();
  // Sanity: #main precisa ter dimensões válidas
  if (rect.width <= 0 || rect.height <= 0) {
    indicatorEl.style.display = 'none';
    return;
  }
  indicatorEl.style.display = '';
  indicatorEl.style.top = `${rect.top + 70}px`;
  indicatorEl.style.left = `${rect.left + 18}px`;
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

  // Liga os listeners de reposicionamento (idempotentes — chama 1x só)
  attachIndicatorRepositionListeners();
  const main = document.querySelector('#main');
  ensureMainResizeObserver(main);
  repositionIndicator();
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

    // Sprint 5+ — sidebar pediu pra abrir o chat de um JID específico
    // (botão "→ Para: X" clicável no card de Ativos). Reusa a mesma
    // rota da tab Relatórios: WPP.chat.openChatBottom via injected.
    case 'ZF_OPEN_CHAT_BY_JID': {
      try {
        if (!msg.jid) {
          respond({ ok: false, error: 'JID ausente' });
          return;
        }
        const result = await callInjectedApi('ZF_API_OPEN_CHAT', { jid: msg.jid });
        respond(result);
      } catch (err) {
        respond({ ok: false, error: err.message || String(err) });
      }
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    return;
  }

  // Sprint 5 — handlers do manager (chrome-extension://) que precisam
  // do contexto do WA Web. Reutilizam internamente switchToChat e
  // callInjectedApi que já existem (sem reescrever sender.js).

  if (message.type === 'ZF_OPEN_CHAT_FROM_MANAGER') {
    // Abre o chat do JID na própria aba do WA. Manager já focou a tab
    // antes via chrome.tabs.update. Usa WPP.chat.openChatBottom (via
    // injected.js) — switchToChat só DETECTA chat aberto, não navega
    // (WA Web bloqueia clicks sintéticos no DOM, então a única rota
    // confiável é a API interna do WA via WPP).
    (async () => {
      try {
        const result = await callInjectedApi('ZF_API_OPEN_CHAT', { jid: message.jid });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // keep channel open pra sendResponse async
  }

  if (message.type === 'ZF_SEND_REPORT_FROM_MANAGER') {
    // Envia texto pro PRÓPRIO JID do user (relatório do Sprint 5).
    // Resolve o phone via getUserPhone() já existente, monta selfJid,
    // e chama callInjectedApi('ZF_API_SEND_TEXT') — mesma rota dos
    // envios de funil sem mexer no sender.js.
    (async () => {
      const result = await sendTextToSelf(message.text);
      sendResponse(result);
    })();
    return true;
  }

  // Sprint 5 ETAPA C — daily report disparado pelo service-worker.
  // Mesma rota do FROM_MANAGER mas com texto já gerado pelo SW.
  if (message.type === 'ZF_DELIVER_REPORT_FROM_SW') {
    (async () => {
      const result = await sendTextToSelf(message.text);
      sendResponse(result);
    })();
    return true;
  }
});

// Sprint 5 ETAPA C — helper compartilhado: envia texto pro próprio
// JID do user via WPP (módulos nativos do WA). Reutilizado pelos 3
// handlers (manager, SW, sidebar/tracker no modo immediate).
async function sendTextToSelf(text) {
  try {
    const phone = await getUserPhone();
    if (!phone) {
      return { ok: false, error: 'Não consegui detectar seu número no WA Web' };
    }
    const selfJid = `${phone}@c.us`;
    return await callInjectedApi('ZF_API_SEND_TEXT', { jid: selfJid, text });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Sprint 5 ETAPA C — Pending report: SW pode ter agendado um envio
// quando o WA Web não estava aberto. Quando o user abre, processamos
// e limpamos. Roda APÓS init() ter validado a chave e o WA Web pronto.
async function processPendingReportIfAny() {
  try {
    const stored = await chrome.storage.local.get('zf_pending_report');
    const pending = stored.zf_pending_report;
    if (!pending || !pending.text) return;
    // Limpa ANTES de tentar — se falhar, não fica em loop infinito.
    // Acessivelmente: o próximo alarm vai gerar um novo texto fresh.
    await chrome.storage.local.remove('zf_pending_report');
    const result = await sendTextToSelf(pending.text);
    if (!result.ok) {
      console.warn('[Zapfire][content] pending report enviou mas falhou:', result.error);
    } else {
      console.log('[Zapfire][content] pending report entregue após reabertura');
    }
  } catch (err) {
    console.warn('[Zapfire][content] processPendingReportIfAny falhou:', err);
  }
}

// Sprint 5 — listener pra mensagens window (ex: tracker do iframe sidebar)
window.addEventListener('message', (event) => {
  if (event.source === window) return; // ignora self (vai pro injected)
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  // Tracker no modo immediate manda texto pra ser enviado pro próprio user
  if (msg.type === 'ZF_SEND_REPORT_TO_SELF' && typeof msg.text === 'string') {
    sendTextToSelf(msg.text).catch((err) => {
      console.warn('[Zapfire][content] ZF_SEND_REPORT_TO_SELF falhou:', err);
    });
  }
});

// Bootstrap inicial: roda quando a página carrega.
// Se a chave NÃO estiver ativa nesse momento, o init mostra o banner
// "Zapfire não ativado" e sai. O listener abaixo cobre o caso de
// ativação posterior (popup → ZF_VALIDATE → service-worker salva
// zf_key) sem precisar refresh manual da aba.
init();

// Re-inicializa quando a chave é ativada/trocada via popup ou painel.
// mountSidebar/mountQuickbar já são idempotentes (early-return se
// iframe já existe), então chamar init() de novo é seguro.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const keyChange = changes.zf_key;
  if (!keyChange) return;

  // Só dispara em "ativação" (undefined → valor) ou "troca de chave"
  // (valor A → valor B). Ignora "logout" (valor → undefined) por ora —
  // desmontar UI no logout fica como melhoria futura se virar pedido.
  const newKey = keyChange.newValue;
  const oldKey = keyChange.oldValue;
  if (!newKey || newKey === oldKey) return;

  console.log('[Zapfire] Chave ativada/trocada — reinicializando sem refresh');

  // Remove o banner "Zapfire não ativado" / "bloqueado" se ainda visível
  const banner = document.getElementById('zapfire-banner');
  if (banner) banner.remove();

  init();
});

// ============================================================
// Sprint 5+ — QuickSearch: busca rápida no input do WA via "/"
// ============================================================
//
// User digita "/" no campo de mensagem do WA Web. Aparece overlay
// flutuante com lista de items + funis filtrados pelo texto após
// o "/". Setas navegam, Enter dispara, Esc fecha.
//
// Fluxo:
//   1. Listener `input` global detecta typing no contenteditable
//      do WA. Filtro: só dispara em divs dentro de #main footer.
//   2. Se texto começa com "/", abre overlay e filtra `qsIndex`
//      (cache local recebido da sidebar via ZF_QS_INDEX_PUSH).
//   3. Setas/Enter/Esc capturados via keydown (preventDefault +
//      stopPropagation pra não vazar pro WA).
//   4. Selecionar item → manda ZF_QS_SEND_ITEM ou ZF_QS_RUN_FUNNEL
//      pra sidebar (que tem acesso ao IndexedDB completo).
//   5. Limpa input via execCommand selectAll+delete (deprecated mas
//      funciona em contenteditable controlado por React).
//
// Cache de índice: warm na inicialização da sidebar; refresh on-demand
// quando overlay abre (cobre items/funis adicionados no manager).
// ============================================================

const QS_TRIGGER_CHAR = '/';
const QS_MAX_RESULTS = 8;

// Cache local do índice (vem da sidebar via postMessage)
let qsIndex = { items: [], funnels: [], lastSyncAt: 0 };

// Estado do overlay
let qsOverlay = null;
let qsCurrentInput = null;
let qsResults = [];
let qsSelectedIndex = 0;
let qsCurrentJid = null; // resolvido on-demand quando dispara

// ------------------------------------------------------------
// Listener pra receber sync da sidebar
// ------------------------------------------------------------
window.addEventListener('message', (event) => {
  if (event.source === window) return;
  const msg = event.data;
  if (msg?.type === 'ZF_QS_INDEX_PUSH') {
    qsIndex = {
      items: Array.isArray(msg.items) ? msg.items : [],
      funnels: Array.isArray(msg.funnels) ? msg.funnels : [],
      lastSyncAt: Date.now(),
    };
  }
});

// Pede sync à sidebar (fresh) — usado quando overlay abre se o
// cache está stale (>30s)
function requestQsIndexFresh() {
  if (!sidebarIframe || !sidebarIframe.contentWindow) return;
  sidebarIframe.contentWindow.postMessage({ type: 'ZF_QS_INDEX_REQUEST' }, '*');
}

// ------------------------------------------------------------
// Detectar input do WA (contenteditable dentro de #main footer)
// ------------------------------------------------------------
function isWaMessageInput(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.getAttribute('contenteditable') !== 'true') return false;
  // O input fica dentro de #main footer. Search box top-left fica
  // em outro lugar (#side header) — assim filtra automaticamente.
  return !!el.closest('#main footer');
}

// ------------------------------------------------------------
// Listeners globais (input + keydown). Capture phase pra interceptar
// ANTES do React do WA processar (especialmente Enter/Tab/Esc).
// ------------------------------------------------------------
document.addEventListener('input', (e) => {
  const input = e.target;
  if (!isWaMessageInput(input)) return;

  const text = (input.textContent || '').trimEnd();

  if (text.startsWith(QS_TRIGGER_CHAR)) {
    qsCurrentInput = input;
    const query = text.slice(1).toLowerCase().trim();
    // Refresh sob demanda se cache > 30s (evita listar items deletados
    // ou perder novos adicionados no manager)
    if (Date.now() - qsIndex.lastSyncAt > 30_000) {
      requestQsIndexFresh();
    }
    qsResults = qsFilter(query);
    qsSelectedIndex = 0;
    qsRenderOverlay();
  } else {
    qsCloseOverlay();
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (!qsOverlay || qsOverlay.style.display === 'none') return;
  if (!qsCurrentInput) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    qsCloseOverlay();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    if (qsResults.length === 0) return;
    qsSelectedIndex = (qsSelectedIndex + 1) % qsResults.length;
    qsUpdateSelection();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    if (qsResults.length === 0) return;
    qsSelectedIndex = (qsSelectedIndex - 1 + qsResults.length) % qsResults.length;
    qsUpdateSelection();
    return;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (qsResults[qsSelectedIndex]) {
      e.preventDefault();
      e.stopPropagation();
      qsSelectResult(qsResults[qsSelectedIndex]);
    }
  }
}, true);

// ------------------------------------------------------------
// Filtragem do índice por substring case-insensitive
// ------------------------------------------------------------
function qsFilter(query) {
  // Funis primeiro (são "ações compostas" — costuma ser o que o user
  // quer mais rápido), depois items
  const all = [
    ...qsIndex.funnels.map((f) => ({
      kind: 'funnel', id: f.id, name: f.name,
      meta: `${f.stepsCount} step${f.stepsCount === 1 ? '' : 's'}`,
    })),
    ...qsIndex.items.map((i) => ({
      kind: 'item', id: i.id, name: i.title || '(sem título)', type: i.type,
      meta: i.type,
    })),
  ];
  const q = (query || '').trim();
  const filtered = q
    ? all.filter((x) => x.name.toLowerCase().includes(q))
    : all;
  return filtered.slice(0, QS_MAX_RESULTS);
}

// ------------------------------------------------------------
// Overlay
// ------------------------------------------------------------
function qsEnsureOverlay() {
  if (qsOverlay) return qsOverlay;
  // CSS injetado uma vez
  const style = document.createElement('style');
  style.textContent = `
    #zf-qs-overlay {
      position: fixed;
      z-index: 2147483647;
      background: #141414;
      border: 1px solid #383838;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 420px;
      min-width: 280px;
      max-height: 320px;
      overflow-y: auto;
      padding: 6px 0;
      color: #f5f5f5;
    }
    #zf-qs-overlay .zf-qs-header {
      padding: 6px 14px 8px;
      font-size: 10px;
      color: #a3a3a3;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid #262626;
    }
    #zf-qs-overlay .zf-qs-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      cursor: pointer;
      transition: background 0.05s;
    }
    #zf-qs-overlay .zf-qs-row.selected,
    #zf-qs-overlay .zf-qs-row:hover {
      background: #1c1c1c;
    }
    #zf-qs-overlay .zf-qs-icon {
      width: 22px;
      height: 22px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 700;
      color: white;
    }
    #zf-qs-overlay .zf-qs-icon--funnel { background: rgba(255,59,48,0.2); color: #ff3b30; }
    #zf-qs-overlay .zf-qs-icon--text   { background: rgba(56,189,248,0.2); color: #38bdf8; }
    #zf-qs-overlay .zf-qs-icon--audio  { background: rgba(168,85,247,0.2); color: #a855f7; }
    #zf-qs-overlay .zf-qs-icon--image,
    #zf-qs-overlay .zf-qs-icon--video  { background: rgba(245,158,11,0.2); color: #f59e0b; }
    #zf-qs-overlay .zf-qs-icon--file   { background: rgba(236,72,153,0.2); color: #ec4899; }
    #zf-qs-overlay .zf-qs-name {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #zf-qs-overlay .zf-qs-meta {
      font-size: 10px;
      color: #a3a3a3;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }
    #zf-qs-overlay .zf-qs-empty {
      padding: 14px;
      text-align: center;
      color: #a3a3a3;
      font-size: 12px;
    }
    #zf-qs-overlay .zf-qs-hint {
      padding: 6px 14px;
      font-size: 10px;
      color: #737373;
      border-top: 1px solid #262626;
      display: flex;
      gap: 12px;
    }
    #zf-qs-overlay .zf-qs-hint kbd {
      background: #262626;
      border-radius: 3px;
      padding: 1px 5px;
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 9px;
      color: #f5f5f5;
    }
  `;
  document.head.appendChild(style);

  qsOverlay = document.createElement('div');
  qsOverlay.id = 'zf-qs-overlay';
  document.body.appendChild(qsOverlay);
  return qsOverlay;
}

const QS_TYPE_LABEL = {
  funnel: 'Funil', text: 'Mensagem', audio: 'Áudio',
  image: 'Imagem', video: 'Vídeo', file: 'Arquivo',
};
const QS_ICON_LETTER = {
  funnel: 'F', text: 'T', audio: 'A',
  image: 'I', video: 'V', file: 'D',
};

function qsRenderOverlay() {
  qsEnsureOverlay();
  if (!qsCurrentInput) return;

  // Posiciona acima do input
  const rect = qsCurrentInput.getBoundingClientRect();
  qsOverlay.style.left = rect.left + 'px';
  qsOverlay.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  qsOverlay.style.width = Math.min(rect.width, 420) + 'px';

  let html = `<div class="zf-qs-header">Buscar e enviar — Zapfire</div>`;

  if (qsResults.length === 0) {
    html += `<div class="zf-qs-empty">Nenhum item encontrado. Esc pra fechar.</div>`;
  } else {
    html += qsResults.map((r, i) => {
      const iconKind = r.kind === 'funnel' ? 'funnel' : r.type;
      const iconLetter = QS_ICON_LETTER[iconKind] || '?';
      const metaLabel = r.kind === 'funnel'
        ? r.meta
        : (QS_TYPE_LABEL[r.type] || r.type);
      return `
        <div class="zf-qs-row ${i === qsSelectedIndex ? 'selected' : ''}" data-index="${i}">
          <span class="zf-qs-icon zf-qs-icon--${iconKind}">${iconLetter}</span>
          <span class="zf-qs-name">${qsEscapeHtml(r.name)}</span>
          <span class="zf-qs-meta">${qsEscapeHtml(metaLabel)}</span>
        </div>
      `;
    }).join('');
  }

  html += `
    <div class="zf-qs-hint">
      <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
      <span><kbd>Enter</kbd> enviar</span>
      <span><kbd>Esc</kbd> fechar</span>
    </div>
  `;

  qsOverlay.innerHTML = html;
  qsOverlay.style.display = 'block';

  // Click handlers
  qsOverlay.querySelectorAll('.zf-qs-row').forEach((row) => {
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // evita perder foco do input do WA
      const idx = parseInt(row.dataset.index, 10);
      if (qsResults[idx]) qsSelectResult(qsResults[idx]);
    });
  });
}

function qsUpdateSelection() {
  if (!qsOverlay) return;
  qsOverlay.querySelectorAll('.zf-qs-row').forEach((row, i) => {
    row.classList.toggle('selected', i === qsSelectedIndex);
    if (i === qsSelectedIndex) row.scrollIntoView({ block: 'nearest' });
  });
}

function qsCloseOverlay() {
  if (qsOverlay) qsOverlay.style.display = 'none';
  qsCurrentInput = null;
  qsResults = [];
  qsSelectedIndex = 0;
}

// ------------------------------------------------------------
// Selecionar resultado: limpa input + dispara envio via sidebar
// ------------------------------------------------------------
async function qsSelectResult(result) {
  if (!qsCurrentInput) return;
  const input = qsCurrentInput;

  // Pega JID do chat ANTES de fechar/limpar.
  // ZF_API_GET_ACTIVE_CHAT retorna { ok, target: { jid, name, phone } }
  // (mesmo shape consumido pela sidebar).
  let jid = null;
  try {
    const active = await callInjectedApi('ZF_API_GET_ACTIVE_CHAT', {});
    jid = active?.target?.jid || null;
  } catch (_) {}

  // Fallback: tenta capturar pelo DOM
  if (!jid) {
    const idObj = getChatIdentifier();
    jid = idObj?.jid || null;
  }

  if (!jid) {
    showQsToast('Não consegui detectar a conversa aberta', 'error');
    return;
  }

  // Limpa input ANTES de mandar (UX melhor — feedback imediato)
  qsClearInput(input);
  qsCloseOverlay();

  // Despacha pra sidebar — ela tem acesso aos blobs do IndexedDB
  if (!sidebarIframe || !sidebarIframe.contentWindow) {
    showQsToast('Sidebar não disponível', 'error');
    return;
  }
  if (result.kind === 'funnel') {
    sidebarIframe.contentWindow.postMessage({
      type: 'ZF_QS_RUN_FUNNEL', funnelId: result.id,
    }, '*');
  } else {
    sidebarIframe.contentWindow.postMessage({
      type: 'ZF_QS_SEND_ITEM', itemId: result.id, jid,
    }, '*');
  }
}

// Limpa contenteditable controlado por React via execCommand
// (deprecated mas ainda funciona pq é o que o WA usa internamente
// e os hooks de React escutam beforeinput/input que o execCommand
// dispara naturalmente).
function qsClearInput(input) {
  try {
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false);
  } catch (err) {
    console.warn('[Zapfire][QS] clearInput falhou:', err);
  }
}

// Toast visível só no contexto do content script (reusa o estilo
// do showBanner mas mais discreto, sem header)
function showQsToast(msg, type = 'info') {
  const colors = { info: '#1a1a1a', error: '#dc2626', success: '#16a34a' };
  const t = document.createElement('div');
  t.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; background: ${colors[type] || colors.info};
    color: white; padding: 10px 18px; border-radius: 6px; font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function qsEscapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

