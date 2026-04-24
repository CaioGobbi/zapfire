// ============================================================
// ZAPFIRE — Service Worker (background)
// ============================================================
// Responsabilidades:
// 1. Guardar a chave e o deviceId no chrome.storage.local
// 2. Fazer a ponte entre o popup/content script e o backend
// 3. Heartbeat periódico pra saber se a chave continua válida
// 4. Notificar o content script quando o status mudar
// ============================================================

// API_BASE vem de ../config.js — arquivo é reescrito pelo build.mjs
// com os valores de prod quando a gente empacota pra Chrome Web Store.
import { API_BASE } from '../config.js';

const STORAGE_KEYS = {
  KEY_VALUE: 'zf_key',
  DEVICE_ID: 'zf_device_id',
  AUTH_STATE: 'zf_auth_state',
  LAST_VALIDATED: 'zf_last_validated',
  // Sprint 4 — estado da licença (code, warning GRACE_PERIOD, daysLeft, etc).
  // Populado após cada /auth/validate + /heartbeat. Consumido pelo banner
  // de grace e pelo gate de envio client-side (sidebar, quickbar, popup).
  LICENSE_STATE: 'zf_license_state',
};

// Converte a resposta do /auth/validate (sucesso ou falha) no shape
// canônico que o grace-banner.js consome. Função pura, sem side effects.
function buildLicenseState(validateResponse) {
  if (!validateResponse) return null;
  return {
    code: validateResponse.code || null,
    warning: validateResponse.warning || null,
    graceEndsAt: validateResponse.data?.graceEndsAt || null,
    daysLeft: validateResponse.data?.daysLeft ?? null,
    phone: validateResponse.data?.boundPhone || null,
    lastCheckedAt: Date.now(),
  };
}

// ------------------------------------------------------------
// DEVICE ID — gerado uma vez por instalação da extensão,
// persiste no chrome.storage.local
// ------------------------------------------------------------
async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.DEVICE_ID);
  if (stored[STORAGE_KEYS.DEVICE_ID]) {
    return stored[STORAGE_KEYS.DEVICE_ID];
  }
  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEYS.DEVICE_ID]: newId });
  return newId;
}

// ------------------------------------------------------------
// VALIDAÇÃO — chamada quando o usuário cola a chave
// e também pelo content script quando detecta o número
// ------------------------------------------------------------
async function validateKey({ keyValue, phone }) {
  const deviceId = await getOrCreateDeviceId();

  try {
    const response = await fetch(`${API_BASE}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyValue,
        phone,
        deviceId,
        chromeVersion: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1],
      }),
    });

    const data = await response.json();

    if (data.ok) {
      // Sucesso — persiste chave + estado
      await chrome.storage.local.set({
        [STORAGE_KEYS.KEY_VALUE]: keyValue,
        [STORAGE_KEYS.AUTH_STATE]: data.data,
        [STORAGE_KEYS.LAST_VALIDATED]: Date.now(),
      });
    }

    // Sprint 4 — sempre atualiza o license state (sucesso OU erro).
    // Tudo que é reativo (banner de grace na sidebar/popup, gate de
    // envio client-side) observa essa chave via chrome.storage.onChanged.
    await chrome.storage.local.set({
      [STORAGE_KEYS.LICENSE_STATE]: buildLicenseState(data),
    });

    return data;
  } catch (err) {
    // Erro de rede — não mexe no license state (mantém último conhecido)
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      message: 'Sem conexão com o servidor Zapfire',
    };
  }
}

// ------------------------------------------------------------
// HEARTBEAT — roda a cada 30min pra revalidar a chave
// ------------------------------------------------------------
async function heartbeat() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.KEY_VALUE);
  const keyValue = stored[STORAGE_KEYS.KEY_VALUE];
  if (!keyValue) return;

  try {
    const response = await fetch(`${API_BASE}/auth/heartbeat`, {
      headers: { 'X-Zapfire-Key': keyValue },
    });
    const data = await response.json();

    if (!data.ok) {
      // Chave invalidada — limpa tudo
      await chrome.storage.local.remove([
        STORAGE_KEYS.KEY_VALUE,
        STORAGE_KEYS.AUTH_STATE,
      ]);
      // Notifica content scripts
      const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'ZF_AUTH_INVALIDATED',
          reason: data.code,
        }).catch(() => {}); // ignora erro se tab não tem content script
      }
    }
  } catch (err) {
    // Sem internet — não faz nada, mantém estado atual
  }
}

// Dispara heartbeat a cada 30min usando alarms
chrome.alarms.create('zf_heartbeat', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'zf_heartbeat') heartbeat();
});

// ------------------------------------------------------------
// MESSAGE ROUTER — popup e content script falam com o bg por aqui
// ------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // sendResponse precisa ser async? retornar true mantém o canal aberto
  (async () => {
    switch (message.type) {
      case 'ZF_VALIDATE': {
        const result = await validateKey(message.payload);
        sendResponse(result);
        break;
      }
      case 'ZF_GET_AUTH_STATE': {
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.KEY_VALUE,
          STORAGE_KEYS.AUTH_STATE,
        ]);
        sendResponse({
          isAuthenticated: !!stored[STORAGE_KEYS.KEY_VALUE],
          state: stored[STORAGE_KEYS.AUTH_STATE] || null,
        });
        break;
      }
      case 'ZF_LOGOUT': {
        await chrome.storage.local.remove([
          STORAGE_KEYS.KEY_VALUE,
          STORAGE_KEYS.AUTH_STATE,
          STORAGE_KEYS.LAST_VALIDATED,
          STORAGE_KEYS.LICENSE_STATE,
        ]);
        // Nota: deviceId NÃO é removido — ele persiste entre logins
        sendResponse({ ok: true });
        break;
      }
      case 'ZF_OPEN_MANAGER': {
        // Abre o gerenciador em nova aba. focus pode ser:
        //   null            → tela inicial
        //   "funnels"       → aba de funis
        //   "edit:ITEM_ID"  → modal de edição do item
        //   "funnel:ID"     → modal de edição do funil
        let url = chrome.runtime.getURL('manager/manager.html');
        const focus = message.focus;
        if (focus === 'funnels') url += '#funnels';
        else if (typeof focus === 'string' && focus.startsWith('funnel:')) {
          url += `#funnel=${focus.slice(7)}`;
        } else if (typeof focus === 'string' && focus.length > 0) {
          url += `#edit=${focus}`;
        }
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // mantém o canal aberto pra resposta async
});

// Log de instalação
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Zapfire] Instalado:', details.reason);
});
