// ============================================================
// ZAPFIRE — Funnel Engine
// ============================================================
// Executa funis (sequência de items com delay entre cada step).
//
// API:
//   const run = runFunnel(funnelId, { sendItem, onProgress });
//   await run.promise; // { ok, completed, cancelled? }
//   run.cancel();      // interrompe a execução em andamento
//
// Quem chama provê:
//   - sendItem(item): async, executa o envio (varia entre
//     contextos — sidebar manda postMessage pro content script,
//     manager poderia mandar pro tab ativo, etc).
//   - onProgress(event): recebe atualizações de fase pra UI:
//       { phase: 'waiting',  current, total, delayMs }
//       { phase: 'sending',  current, total, item }
//       { phase: 'sent',     current, total, item }
//       { phase: 'error',    current, total, item?, error }
//
// IMPORTANTE: a engine roda no contexto que a chamou. No caso
// da sidebar, isso é o iframe da extensão. Enquanto o iframe
// estiver no DOM da página do WA, os timers continuam rodando
// — fechar a sidebar (transform: translateX) não para o funil.
// Trocar de aba ou fechar o WA mata tudo.
// ============================================================

import { getFunnel, getItem, incrementItemUses } from './storage.js';

// Mapa de execuções ativas — pra cancelamento por id externo
const activeRuns = new Map();

// ------------------------------------------------------------
// Lock de envio — serializa sends entre múltiplos funis paralelos
// ------------------------------------------------------------
// Só pode haver UMA conversa aberta no WA Web por vez. Se dois
// funis tentarem enviar simultaneamente, eles disputariam a UI
// (um sobrescreve a troca de chat do outro). Pra evitar isso,
// encadeamos todas as operações de envio numa Promise chain
// global. Os DELAYS dos funis continuam rodando em paralelo —
// só o ato físico de "trocar chat + enviar" é serializado.
// ------------------------------------------------------------
let sendChain = Promise.resolve();

function withSendLock(fn) {
  const next = sendChain.then(fn, fn); // continua mesmo se o anterior falhou
  // Garante que rejects não quebrem a chain pra próximas tasks
  sendChain = next.catch(() => {});
  return next;
}

export function runFunnel(funnelId, { sendItem, onProgress } = {}) {
  if (typeof sendItem !== 'function') {
    throw new Error('runFunnel requer sendItem(item) callback');
  }

  const runId = crypto.randomUUID();
  const controller = { cancelled: false };
  activeRuns.set(runId, controller);

  const emit = (ev) => {
    try { onProgress?.(ev); } catch (_) {}
  };

  const promise = (async () => {
    const funnel = await getFunnel(funnelId);
    if (!funnel) {
      activeRuns.delete(runId);
      return { ok: false, error: 'Funil não encontrado' };
    }

    const total = funnel.steps.length;
    let completed = 0;

    for (let i = 0; i < total; i++) {
      if (controller.cancelled) break;

      const step = funnel.steps[i];

      // 1) Delay ANTES desse step (incluindo o primeiro, se >0)
      if (step.delayMs > 0) {
        emit({ phase: 'waiting', current: i + 1, total, delayMs: step.delayMs });
        await sleepCancellable(step.delayMs, controller);
        if (controller.cancelled) break;
      }

      // 2) Busca item
      const item = await getItem(step.itemId);
      if (!item) {
        emit({
          phase: 'error',
          current: i + 1,
          total,
          error: 'Item não encontrado (foi excluído?)',
        });
        // Não trava o funil — segue pro próximo
        continue;
      }

      // 3) Envia — serializado entre todos os funis ativos
      emit({ phase: 'sending', current: i + 1, total, item });
      let result;
      try {
        result = await withSendLock(() => sendItem(item));
      } catch (err) {
        result = { ok: false, error: err.message || String(err) };
      }

      if (controller.cancelled) break;

      if (result?.ok) {
        completed++;
        await incrementItemUses(item.id);
        emit({ phase: 'sent', current: i + 1, total, item });
      } else {
        emit({
          phase: 'error',
          current: i + 1,
          total,
          item,
          error: result?.error || 'Falha desconhecida',
        });
        // Pra MVP segue mesmo com erro — facilita testar funis
        // grandes sem precisar começar tudo de novo. Iteração
        // futura: tornar "abortar em erro" configurável.
      }
    }

    activeRuns.delete(runId);

    if (controller.cancelled) {
      return { ok: false, cancelled: true, completed };
    }
    return { ok: true, completed };
  })();

  return {
    runId,
    promise,
    cancel: () => { controller.cancelled = true; },
  };
}

// Cancela uma execução por runId (caso quem chama tenha
// perdido a referência — ex: outra aba do manager)
export function cancelRun(runId) {
  const c = activeRuns.get(runId);
  if (c) c.cancelled = true;
}

// ------------------------------------------------------------
// Sleep que acorda mais cedo se o controller for cancelado
// ------------------------------------------------------------
function sleepCancellable(ms, controller) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer = null;
    let poller = null;

    const finish = () => {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      resolve();
    };

    timer = setTimeout(finish, ms);
    // Polling barato pra detectar cancelamento sem esperar todo
    // o delay (importante pra delays longos, ex: 5min)
    poller = setInterval(() => {
      if (controller.cancelled || Date.now() - startedAt >= ms) {
        finish();
      }
    }, 100);
  });
}
