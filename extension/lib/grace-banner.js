// ============================================================
// ZAPFIRE — Grace banner + license state (Sprint 4 ETAPA 7)
// ============================================================
// Centraliza a lógica de exibição do banner de aviso da
// assinatura na sidebar/quickbar. O estado vive em
// chrome.storage.local.zf_license_state e é atualizado pelo
// service-worker após cada /auth/validate.
//
// Estados possíveis:
//   state = null/undefined      → fresh install, sem validate
//                                 ainda. Permissivo (sem banner,
//                                 sem gate de envio).
//   state.code = 'SUCCESS'      → OK, sem banner.
//   state.warning = 'GRACE_PERIOD'
//                               → Banner AMARELO. Envios continuam.
//   state.code in [EXPIRED,
//                  BLOCKED,
//                  WRONG_PHONE,
//                  INVALID_KEY,
//                  DEVICE_LIMIT]→ Banner VERMELHO. Gate bloqueia
//                                 envios no client.
//
// Regra de ouro desse arquivo: NÃO importa/exporta nada relacionado
// a envio, chat, storage do usuário. Só gerencia o banner e os
// predicados de licença.
// ============================================================

export const LICENSE_STATE_KEY = 'zf_license_state';

// TODO (Sprint 7): trocar por prod em build time.
// Por ora hardcoded em localhost:3001 (mesmo PANEL_BASE_URL do backend).
export const PANEL_URL = 'http://localhost:3001';

const BLOCKING_CODES = new Set([
  'EXPIRED',
  'BLOCKED',
  'WRONG_PHONE',
  'INVALID_KEY',
  'DEVICE_LIMIT',
]);

// ------------------------------------------------------------
// Predicados
// ------------------------------------------------------------
export function isInGrace(state) {
  return !!(state && state.warning === 'GRACE_PERIOD');
}

export function isBlocked(state) {
  return !!(state && BLOCKING_CODES.has(state.code));
}

// Permite enviar se: (a) ainda não validou, OU (b) code=SUCCESS (com ou sem grace).
// Enquanto estiver em grace, deixa enviar — aviso é visual.
export function canSend(state) {
  if (!state) return true; // sem validate ainda → permissivo
  return !isBlocked(state);
}

export function blockReason(state) {
  if (!state) return null;
  return BLOCKING_CODES.has(state.code) ? state.code : null;
}

export function gracePayload(state) {
  if (!isInGrace(state)) return null;
  return {
    daysLeft: state.daysLeft ?? null,
    graceEndsAt: state.graceEndsAt ?? null,
  };
}

export function renewUrl() {
  return `${PANEL_URL}/assinatura`;
}

// ------------------------------------------------------------
// Reading
// ------------------------------------------------------------
export async function readLicenseState() {
  try {
    const res = await chrome.storage.local.get(LICENSE_STATE_KEY);
    return res[LICENSE_STATE_KEY] || null;
  } catch {
    return null;
  }
}

// Registra listener e dispara callback com o valor atual de cara.
// Retorna função de unsubscribe.
export function subscribeLicenseState(callback) {
  // Leitura inicial
  readLicenseState().then(callback);

  const listener = (changes, area) => {
    if (area !== 'local') return;
    if (!changes[LICENSE_STATE_KEY]) return;
    callback(changes[LICENSE_STATE_KEY].newValue || null);
  };
  try {
    chrome.storage.onChanged.addListener(listener);
  } catch {}
  return () => {
    try { chrome.storage.onChanged.removeListener(listener); } catch {}
  };
}

// ------------------------------------------------------------
// Render — cria/esconde banner em um container arbitrário.
// Injeta CSS uma única vez no documento.
// ------------------------------------------------------------
let _stylesInjected = false;
function ensureStyles() {
  if (_stylesInjected) return;
  const style = document.createElement('style');
  style.id = 'zf-grace-banner-style';
  style.textContent = `
    .zf-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      line-height: 1.35;
      margin: 8px 10px;
    }
    .zf-banner-icon {
      flex-shrink: 0;
      width: 18px; height: 18px;
      display: grid; place-items: center;
      font-size: 14px;
    }
    .zf-banner-body {
      flex: 1;
      min-width: 0;
    }
    .zf-banner-title {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .zf-banner-sub {
      opacity: 0.85;
      font-size: 11px;
    }
    .zf-banner-btn {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid currentColor;
      color: inherit;
      padding: 5px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s;
    }
    .zf-banner-btn:hover { opacity: 0.8; }
    .zf-banner--warning {
      background: rgba(255, 107, 0, 0.12);
      border-color: rgba(255, 107, 0, 0.45);
      color: #ffb27a;
    }
    .zf-banner--danger {
      background: rgba(220, 38, 38, 0.12);
      border-color: rgba(220, 38, 38, 0.5);
      color: #ff8b8b;
    }
    /* Quickbar é apertada — versão compacta */
    .zf-banner--compact {
      padding: 4px 8px;
      margin: 0;
      font-size: 11px;
      border-radius: 4px;
    }
    .zf-banner--compact .zf-banner-sub { display: none; }
    .zf-banner--compact .zf-banner-title { font-size: 11px; }
  `;
  document.head.appendChild(style);
  _stylesInjected = true;
}

const BLOCK_MESSAGES = {
  EXPIRED:      'Sua assinatura venceu. Renove para voltar a enviar.',
  BLOCKED:      'Sua chave foi bloqueada. Entre em contato com o suporte.',
  WRONG_PHONE:  'Esta chave está vinculada a outro número de WhatsApp.',
  INVALID_KEY:  'Chave inválida. Faça login novamente no popup.',
  DEVICE_LIMIT: 'Limite de dispositivos atingido. Gerencie no painel.',
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHTML(state, { compact = false } = {}) {
  const base = compact ? 'zf-banner zf-banner--compact ' : 'zf-banner ';
  if (isInGrace(state)) {
    const d = state.daysLeft ?? '?';
    return `<div class="${base}zf-banner--warning">
      <span class="zf-banner-icon">⚠</span>
      <div class="zf-banner-body">
        <div class="zf-banner-title">Assinatura vencida — ${escapeHtml(d)} dia${d === 1 ? '' : 's'} pra renovar</div>
        <div class="zf-banner-sub">Você mantém acesso até o fim do período de graça.</div>
      </div>
      <a href="${renewUrl()}" target="_blank" rel="noopener" class="zf-banner-btn">Renovar</a>
    </div>`;
  }
  if (isBlocked(state)) {
    const reason = blockReason(state);
    const msg = BLOCK_MESSAGES[reason] || 'Chave indisponível.';
    return `<div class="${base}zf-banner--danger">
      <span class="zf-banner-icon">⛔</span>
      <div class="zf-banner-body">
        <div class="zf-banner-title">Envios bloqueados</div>
        <div class="zf-banner-sub">${escapeHtml(msg)}</div>
      </div>
      <a href="${renewUrl()}" target="_blank" rel="noopener" class="zf-banner-btn">Ver painel</a>
    </div>`;
  }
  return '';
}

// Renderiza ou esconde o banner dentro de um container.
// opts.compact = true → estilo reduzido pra quickbar
export function renderBannerInto(container, state, opts = {}) {
  if (!container) return;
  ensureStyles();
  const html = buildHTML(state, opts);
  if (!html) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = html;
}
