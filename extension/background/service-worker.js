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
// Sprint 5 ETAPA C — gerar texto do relatório no SW (lê IndexedDB
// via storage.js, agrupa via report-template.js, envia via content.js).
import { listRuns, listFunnels } from '../lib/storage.js';
import { generateReportText, groupRunsByFunnel } from '../lib/report-template.js';

const STORAGE_KEYS = {
  KEY_VALUE: 'zf_key',
  DEVICE_ID: 'zf_device_id',
  AUTH_STATE: 'zf_auth_state',
  LAST_VALIDATED: 'zf_last_validated',
  // Sprint 4 — estado da licença (code, warning GRACE_PERIOD, daysLeft, etc).
  // Populado após cada /auth/validate + /heartbeat. Consumido pelo banner
  // de grace e pelo gate de envio client-side (sidebar, quickbar, popup).
  LICENSE_STATE: 'zf_license_state',
  // Sprint 5 — features do plano atual (tracking, dailyReport,
  // maxMonitoredFunnels). Espelha plan.features do backend pra que UI
  // (manager, sidebar) leia sem precisar refazer /validate só pra ler.
  // Observada via chrome.storage.onChanged pelo manager.
  PLAN_FEATURES: 'zf_plan_features',
  // Sprint 5 ETAPA C — config de entrega automática espelhada pelo
  // manager (que escreve no IndexedDB meta como source-of-truth).
  // Espelhada aqui pra que o SW leia sem precisar abrir IndexedDB
  // toda vez que o alarm dispara.
  REPORTS_DELIVERY: 'zf_reports_delivery',
  // Sprint 5 ETAPA C — texto do relatório que o SW tentou enviar mas
  // o WA Web não estava aberto. Content.js consome no bootstrap.
  PENDING_REPORT: 'zf_pending_report',
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
        // Sprint 5 — espelha plan.features pra UI consultar sem rede.
        // {} se backend não retornar (ex: plano legacy sem features setado).
        [STORAGE_KEYS.PLAN_FEATURES]: data.data?.plan?.features || {},
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
  // Sprint 5 ETAPA C — alarm do daily report (modos fixed e every4h)
  if (alarm.name === DELIVERY_ALARM_NAME) {
    processScheduledDelivery().catch((err) => {
      console.warn('[Zapfire][SW] processScheduledDelivery falhou:', err);
    });
  }
});

// ============================================================
// Sprint 5 ETAPA C — Daily report automático
// ============================================================
//
// Fluxo:
// 1. Manager salva config em IndexedDB meta('reports.delivery') +
//    espelha em chrome.storage.local + manda ZF_RESCHEDULE_DELIVERY
//    pro SW
// 2. SW (re)cria o alarm baseado no modo:
//    - fixed:    when=próximo HH:MM local, periodInMinutes=1440
//    - every4h:  periodInMinutes=240
//    - immediate/disabled: limpa alarm (immediate é hook no tracker,
//      não usa alarm)
// 3. Quando alarm dispara, SW lê config + runs do IndexedDB +
//    gera texto via report-template.js + manda pro content.js
//    via chrome.tabs.sendMessage
// 4. Se WA Web não tá aberto: salva em zf_pending_report e
//    content.js processa no bootstrap quando o user abrir
// ============================================================

const DELIVERY_ALARM_NAME = 'zf_daily_report';

// Calcula timestamp ms da próxima ocorrência de HH:MM no fuso local.
// Se o horário JÁ passou hoje, agenda pra amanhã.
function nextOccurrenceOf(hhmm) {
  const [h, m] = (hhmm || '18:00').split(':').map(Number);
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

async function setupDeliveryAlarm(config) {
  // Sempre limpa o alarm antigo antes de recriar
  await chrome.alarms.clear(DELIVERY_ALARM_NAME);
  if (!config || config.mode === 'disabled' || config.mode === 'immediate') {
    return; // immediate não usa alarm — é hook no funnel-tracker
  }
  if (config.mode === 'fixed') {
    const when = nextOccurrenceOf(config.fixedTime || '18:00');
    chrome.alarms.create(DELIVERY_ALARM_NAME, {
      when,
      periodInMinutes: 1440, // 24h
    });
    return;
  }
  if (config.mode === 'every4h') {
    chrome.alarms.create(DELIVERY_ALARM_NAME, {
      delayInMinutes: 240,
      periodInMinutes: 240,
    });
    return;
  }
}

async function readDeliveryConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.REPORTS_DELIVERY);
  return stored[STORAGE_KEYS.REPORTS_DELIVERY] || null;
}

// Lê runs + funis monitorados do IndexedDB e gera o texto do relatório
// pra um período específico (since em ms). Filtra pelos funnelIds da
// config. Retorna string (pode ser vazia se não há runs).
async function buildReportTextForDelivery(config, since) {
  const allFunnels = await listFunnels();
  const monitored = allFunnels.filter((f) =>
    f.trackingEnabled && (config.funnelIds || []).includes(f.id),
  );
  if (monitored.length === 0) return null;

  const runs = await listRuns({ status: 'completed', since, until: Date.now() });
  // Filtra apenas runs dos funis incluídos na config
  const filteredRuns = runs.filter((r) => (config.funnelIds || []).includes(r.funnelId));
  if (filteredRuns.length === 0) return null;

  const grouped = groupRunsByFunnel(filteredRuns, monitored);
  const periodKey = config.mode === 'every4h' ? '4h' : 'today';
  return generateReportText(grouped, periodKey);
}

// Disparado pelo alarm. Lê config, gera texto, despacha pra WA Web tab
// ou salva como pending se sem tab aberta.
async function processScheduledDelivery() {
  const config = await readDeliveryConfig();
  if (!config || config.mode === 'disabled' || config.mode === 'immediate') {
    return; // não deveria nem ter alarm ativo, mas guard anyway
  }

  // Janela de tempo coberta pelo relatório
  const now = Date.now();
  let since;
  if (config.mode === 'fixed') {
    // Última 24h (ou desde lastSentAt se mais recente, evitando duplicar)
    since = config.lastSentAt && (now - config.lastSentAt) < 86400_000
      ? config.lastSentAt
      : now - 86400_000;
  } else if (config.mode === 'every4h') {
    since = config.lastSentAt && (now - config.lastSentAt) < 4 * 3600_000
      ? config.lastSentAt
      : now - 4 * 3600_000;
  } else {
    since = now - 86400_000;
  }

  const text = await buildReportTextForDelivery(config, since);
  if (!text) {
    // Sem leads no período — não envia mensagem vazia
    console.log('[Zapfire][SW] daily report: sem leads no período, skip');
    await markDeliverySent(config); // mas marca como "checado" pra evitar
    return;                          // ficar consultando cedo demais
  }

  await deliverReportTextOrQueue(text, { mode: config.mode });
  await markDeliverySent(config);
}

async function markDeliverySent(config) {
  const updated = { ...config, lastSentAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEYS.REPORTS_DELIVERY]: updated });
  // O manager atualiza o IndexedDB meta na próxima abertura via load.
  // Aceitável estar levemente dessincronizado (lastSentAt é não crítico).
}

// Tenta entregar via tab WA Web. Se sem tab, salva pendingReport
// pra content.js processar quando user abrir o WA Web.
async function deliverReportTextOrQueue(text, meta = {}) {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (tabs && tabs.length > 0) {
    try {
      const result = await chrome.tabs.sendMessage(tabs[0].id, {
        type: 'ZF_DELIVER_REPORT_FROM_SW',
        text,
      });
      if (result?.ok) return { ok: true, delivered: true };
      // Se falhou, cai no pending pra tentar de novo no próximo init
    } catch (_) {
      // Content script pode não estar pronto ainda — cai no pending
    }
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.PENDING_REPORT]: {
      text,
      mode: meta.mode || null,
      queuedAt: Date.now(),
    },
  });
  return { ok: true, queued: true };
}

// Chamado no startup do SW pra reagendar alarms baseado na config
// salva (ex: extensão atualizou, browser reiniciou). Alarms persistem
// entre restarts do SW, mas redundância é barata.
async function bootstrapDeliveryAlarm() {
  try {
    const config = await readDeliveryConfig();
    if (config) await setupDeliveryAlarm(config);
  } catch (err) {
    console.warn('[Zapfire][SW] bootstrap delivery alarm falhou:', err);
  }
}
chrome.runtime.onStartup.addListener(bootstrapDeliveryAlarm);
chrome.runtime.onInstalled.addListener(bootstrapDeliveryAlarm);
// E também imediatamente no carregamento do SW (cobre reload da extensão)
bootstrapDeliveryAlarm();

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
          STORAGE_KEYS.PLAN_FEATURES,
        ]);
        // Nota: deviceId NÃO é removido — ele persiste entre logins
        sendResponse({ ok: true });
        break;
      }
      // Sprint 5 ETAPA C — manager pediu pra reagendar alarm de delivery
      case 'ZF_RESCHEDULE_DELIVERY': {
        try {
          const config = message.config || (await readDeliveryConfig());
          await setupDeliveryAlarm(config);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
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
