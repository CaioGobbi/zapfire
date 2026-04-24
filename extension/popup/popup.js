// ============================================================
// ZAPFIRE — Popup
// ============================================================

import {
  subscribeLicenseState,
  renderBannerInto,
  isInGrace,
  isBlocked,
} from '../lib/grace-banner.js';

const $ = (id) => document.getElementById(id);

const screens = {
  login: $('screen-login'),
  auth: $('screen-auth'),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[name].classList.add('active');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR');
}

function maskPhone(phone) {
  // "5511999999999" -> "+55 11 9****-9999"
  if (!phone || phone.length < 8) return phone || '—';
  const cc = phone.slice(0, 2);
  const ddd = phone.slice(2, 4);
  const start = phone.slice(4, 5);
  const end = phone.slice(-4);
  return `+${cc} ${ddd} ${start}****-${end}`;
}

// ------------------------------------------------------------
// Bootstrap — checa estado atual
// ------------------------------------------------------------
async function init() {
  const state = await chrome.runtime.sendMessage({ type: 'ZF_GET_AUTH_STATE' });

  if (state.isAuthenticated && state.state) {
    renderAuthScreen(state.state);
  } else {
    showScreen('login');
  }
}

function renderAuthScreen(data) {
  $('auth-label').textContent = data.label || '—';
  $('auth-phone').textContent = maskPhone(data.boundPhone);
  $('auth-plan').textContent = data.plan?.name || '—';
  $('auth-expires').textContent = formatDate(data.expiresAt);
  showScreen('auth');
}

// Sprint 4 — atualiza o badge de status do card conforme o license state.
// "Ativa" (verde) por padrão; "Aviso" (amarelo) em grace; "Bloqueada" (vermelho)
// quando EXPIRED/BLOCKED/etc.
function paintStatusBadge(lic) {
  const badge = $('auth-status-badge');
  if (!badge) return;
  badge.classList.remove('success', 'warning', 'danger');
  if (isBlocked(lic)) {
    badge.classList.add('danger');
    badge.textContent = 'Bloqueada';
  } else if (isInGrace(lic)) {
    badge.classList.add('warning');
    badge.textContent = 'Aviso';
  } else {
    badge.classList.add('success');
    badge.textContent = 'Ativa';
  }
}

// ------------------------------------------------------------
// Login
// ------------------------------------------------------------
$('btn-login').addEventListener('click', async () => {
  const key = $('input-key').value.trim().toLowerCase();
  const errorEl = $('login-error');
  errorEl.style.display = 'none';

  // Validação de formato antes de chamar o backend
  if (!/^[a-f0-9]{32}$/.test(key)) {
    errorEl.textContent = 'Chave inválida. Deve ter 32 caracteres (a-f, 0-9).';
    errorEl.style.display = 'block';
    return;
  }

  // A gente precisa do número do WA Web — pega da aba ativa
  const [tab] = await chrome.tabs.query({
    active: true,
    url: 'https://web.whatsapp.com/*',
  });

  if (!tab) {
    errorEl.textContent = 'Abra o WhatsApp Web em uma aba antes de ativar.';
    errorEl.style.display = 'block';
    return;
  }

  $('btn-login').disabled = true;
  $('btn-login').textContent = 'Validando...';

  // Pede pro content script extrair o número e dispara validação
  try {
    const [{ result: phone }] = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => {
    // Tenta localStorage['last-wid-md'] primeiro
    try {
      const raw = localStorage.getItem('last-wid-md');
      if (raw) {
        const clean = raw.replace(/"/g, '').split('@')[0].split(':')[0];
        if (/^\d{10,15}$/.test(clean)) return clean;
      }
    } catch (e) {}

    // Fallback: varrer localStorage
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
  },
});

    if (!phone) {
      errorEl.textContent = 'Não conseguimos ler o número do WhatsApp Web. Recarregue a página e tente de novo.';
      errorEl.style.display = 'block';
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: 'ZF_VALIDATE',
      payload: { keyValue: key, phone },
    });

    if (!result.ok) {
      errorEl.textContent = result.message || 'Falha ao validar chave.';
      errorEl.style.display = 'block';
      return;
    }

    renderAuthScreen(result.data);
  } catch (err) {
    errorEl.textContent = 'Erro: ' + err.message;
    errorEl.style.display = 'block';
  } finally {
    $('btn-login').disabled = false;
    $('btn-login').textContent = 'Ativar';
  }
});

// ------------------------------------------------------------
// Abrir gerenciador
// ------------------------------------------------------------
$('btn-open-manager').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'ZF_OPEN_MANAGER' });
  window.close(); // fecha o popup
});

// ------------------------------------------------------------
// Logout
// ------------------------------------------------------------
$('btn-logout').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'ZF_LOGOUT' });
  $('input-key').value = '';
  showScreen('login');
});

// Sprint 4 — subscribe no license state: repinta banner + badge.
// Roda sempre (tela login também lê, mas renderBannerInto só emite
// HTML se state tiver conteúdo e o banner é filho de #screen-auth,
// então só aparece quando a tela auth estiver ativa)
subscribeLicenseState((lic) => {
  renderBannerInto($('license-banner'), lic);
  paintStatusBadge(lic);
});

init();
