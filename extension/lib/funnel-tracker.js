// ============================================================
// ZAPFIRE — Funnel Tracker (Sprint 5)
// ============================================================
// Wrapper opcional sobre runFunnel() que registra a execução em
// `funnel_runs` quando o funil tem `trackingEnabled: true`.
//
// Quem chama (sidebar, manager, futuramente quickbar) usa SEMPRE
// `runFunnelWithTracking(funnel, target, opts)`. Se o funil não
// tem tracking ligado, é passthrough direto pro runFunnel — zero
// custo, zero entry no IndexedDB.
//
// Toda escrita no storage acontece dentro dos hooks (onRunStart /
// onStepComplete / onStepError / onRunFinish) que são try/catch
// no engine — então erro de IndexedDB nunca derruba o envio.
//
// Comentários em PT-BR, ES module, sem libs novas.
// ============================================================

import { runFunnel } from './funnel-engine.js';
import { addRun, updateRun, getRun, listRuns } from './storage.js';

// ------------------------------------------------------------
// Mutex por runId — serializa reads-modify-writes no IndexedDB
// ------------------------------------------------------------
// O engine chama os hooks via safeHook (sync, sem await). Como os
// nossos handlers são async (fazem getRun + updateRun), eles rodam
// CONCORRENTES — múltiplos onStepComplete + onRunFinish disparados
// quase juntos hit "await getRun" intercalado, geram snapshots stale,
// e a última escrita sobrescreve as outras. Resultado observado em
// prod: run com completedSteps=totalSteps mas status ainda 'running'
// e finishedAt null porque onStepComplete chegou DEPOIS do
// onRunFinish e clobberou.
//
// Solução: cada operação de write entra numa Promise chain por runId.
// Próxima espera a anterior terminar antes de começar. Garante ordem
// strict: addRun → step1 → step2 → ... → finish, sem race.
// ------------------------------------------------------------
const runWriteChains = new Map();

function chainWrite(runId, task) {
  const prev = runWriteChains.get(runId) || Promise.resolve();
  const next = prev.then(task, task); // continua mesmo se anterior rejeitou
  // Catch interno pra não vazar unhandled rejection no link da chain.
  // O caller ainda recebe o `next` original, então pode tratar erros.
  runWriteChains.set(runId, next.catch(() => {}));
  return next;
}

function clearChain(runId) {
  runWriteChains.delete(runId);
}

// ------------------------------------------------------------
// Reconciliação de runs órfãos (Sprint 5 — chamada no startup)
// ------------------------------------------------------------
// Corrige 2 cenários de runs ficarem presos em 'running':
//
// 1. Tab fechada no meio: engine não terminou de chamar onRunFinish.
//    Detecta por startedAt > 24h. Marca 'failed' com finishedAt=now.
//
// 2. Race condition antiga (pre-fix do mutex): completedSteps já
//    bate com totalSteps E todos os steps[] têm success=true MAS
//    status ficou 'running' porque um onStepComplete stale
//    sobrescreveu o onRunFinish. Marca 'completed' usando o último
//    steps[].sentAt como finishedAt (mais preciso que now).
//
// Idempotente — re-roda quantas vezes quiser sem efeito colateral.
// Retorna { fixed, failed } com contagens pra logar.
// ------------------------------------------------------------
const ZOMBIE_RUN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

export async function reconcileOrphanRuns() {
  const orphans = await listRuns({ status: 'running' });
  let fixed = 0;
  let failed = 0;
  const now = Date.now();

  for (const run of orphans) {
    const allStepsDone =
      typeof run.totalSteps === 'number' &&
      typeof run.completedSteps === 'number' &&
      run.totalSteps > 0 &&
      run.completedSteps >= run.totalSteps;

    if (allStepsDone) {
      // Caso 2: run terminou mas status não atualizou — recupera
      const lastSentAt = (run.steps || [])
        .map((s) => s.sentAt || 0)
        .reduce((max, t) => (t > max ? t : max), run.startedAt || now);
      try {
        await updateRun(run.id, {
          finishedAt: lastSentAt || now,
          status: 'completed',
        });
        fixed++;
      } catch (err) {
        console.warn('[funnel-tracker] reconcile (completed) falhou:', err);
      }
      continue;
    }

    if (run.startedAt && now - run.startedAt > ZOMBIE_RUN_THRESHOLD_MS) {
      // Caso 1: zumbi (>24h sem terminar). Marca como falhou.
      try {
        await updateRun(run.id, {
          finishedAt: now,
          status: 'failed',
        });
        failed++;
      } catch (err) {
        console.warn('[funnel-tracker] reconcile (zombie) falhou:', err);
      }
    }
    // Senão: run < 24h ainda pode estar legitimamente rodando
    // (ex: funil com delay grande entre steps). Deixa quieto.
  }

  return { fixed, failed };
}

// ------------------------------------------------------------
// API pública
// ------------------------------------------------------------
//
// Args:
//   funnel  — objeto completo lido do storage (com trackingEnabled etc).
//             NÃO passamos só o id pra evitar re-fetch — o engine já busca.
//   target  — { jid, name? } da conversa onde o funil vai rodar.
//   opts    — { sendItem, onProgress, ...userHooks } pro runFunnel original.
//             userHooks (onRunStart/onStepComplete/etc) do caller são
//             encadeados COM os do tracker — chamamos os dois.
//
// Retorna o mesmo shape de runFunnel: { runId, promise, cancel }.
// ------------------------------------------------------------
export function runFunnelWithTracking(funnel, target, opts = {}) {
  if (!funnel || !funnel.id) {
    throw new Error('runFunnelWithTracking precisa do objeto funnel completo');
  }
  if (!target || typeof target !== 'object') {
    throw new Error('runFunnelWithTracking precisa de target { jid, name? }');
  }

  // Funil sem tracking → passthrough direto, sem tocar no IndexedDB
  if (!funnel.trackingEnabled) {
    return runFunnel(funnel.id, opts);
  }

  // Encadeia hooks: tracker primeiro, depois os do caller (se houver).
  // Importante: o engine já invoca os hooks em try/catch, então mesmo
  // se a escrita no storage falhar (ex: quota cheia, banco fechado),
  // o run continua e o caller recebe seus eventos normalmente.
  const userOnRunStart = opts.onRunStart;
  const userOnStepComplete = opts.onStepComplete;
  const userOnStepError = opts.onStepError;
  const userOnRunFinish = opts.onRunFinish;

  // ID do run no nosso storage. Usamos o runId do engine como id do
  // entry pra facilitar correlação em logs/debug.
  let storageRunId = null;

  const wrappedOpts = {
    ...opts,

    onRunStart: async (meta) => {
      // meta = { runId, funnelId, totalSteps }
      storageRunId = meta.runId;
      await chainWrite(meta.runId, async () => {
        try {
          await addRun({
            id: meta.runId,
            funnelId: funnel.id,
            funnelName: funnel.name,
            leadJid: target.jid,
            leadName: target.name || null,
            startedAt: Date.now(),
            totalSteps: meta.totalSteps,
            completedSteps: 0,
            status: 'running',
            steps: [],
          });
        } catch (err) {
          console.warn('[funnel-tracker] addRun falhou:', err);
        }
      });
      if (typeof userOnRunStart === 'function') userOnRunStart(meta);
    },

    onStepComplete: async (meta) => {
      // meta = { runId, stepIndex, totalSteps, item, sentAt }
      await chainWrite(meta.runId, async () => {
        try {
          const current = await getRun(meta.runId);
          if (!current) return;
          await updateRun(meta.runId, {
            completedSteps: (current.completedSteps || 0) + 1,
            steps: [
              ...(current.steps || []),
              {
                stepId: `${meta.runId}-${meta.stepIndex}`,
                type: meta.item?.type || null,
                sentAt: meta.sentAt,
                success: true,
              },
            ],
          });
        } catch (err) {
          console.warn('[funnel-tracker] updateRun (complete) falhou:', err);
        }
      });
      if (typeof userOnStepComplete === 'function') userOnStepComplete(meta);
    },

    onStepError: async (meta) => {
      // meta = { runId, stepIndex, totalSteps, item?, error, sentAt }
      await chainWrite(meta.runId, async () => {
        try {
          const current = await getRun(meta.runId);
          if (!current) return;
          await updateRun(meta.runId, {
            steps: [
              ...(current.steps || []),
              {
                stepId: `${meta.runId}-${meta.stepIndex}`,
                type: meta.item?.type || null,
                sentAt: meta.sentAt,
                success: false,
                error: meta.error,
              },
            ],
          });
        } catch (err) {
          console.warn('[funnel-tracker] updateRun (error) falhou:', err);
        }
      });
      if (typeof userOnStepError === 'function') userOnStepError(meta);
    },

    onRunFinish: async (meta) => {
      // meta = { runId, status, completed, total, finishedAt }
      // chainWrite garante que esse update roda DEPOIS de todos os
      // step writes pendentes — caso contrário o status='completed'
      // seria sobrescrito por um step handler stale escrevendo depois.
      await chainWrite(meta.runId, async () => {
        try {
          await updateRun(meta.runId, {
            finishedAt: meta.finishedAt,
            completedSteps: meta.completed,
            status: meta.status,  // 'completed' | 'cancelled' | 'failed'
          });
        } catch (err) {
          console.warn('[funnel-tracker] updateRun (finish) falhou:', err);
        }
      });
      // Limpa o slot do mapa pra não vazar memória ao longo do tempo
      clearChain(meta.runId);
      if (typeof userOnRunFinish === 'function') userOnRunFinish(meta);
    },
  };

  return runFunnel(funnel.id, wrappedOpts);
}
