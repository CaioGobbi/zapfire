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
import { addRun, updateRun, getRun } from './storage.js';

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
        // Não bloqueia o run — só loga
        console.warn('[funnel-tracker] addRun falhou:', err);
      }
      // Repassa pro caller (se passou)
      if (typeof userOnRunStart === 'function') userOnRunStart(meta);
    },

    onStepComplete: async (meta) => {
      // meta = { runId, stepIndex, totalSteps, item, sentAt }
      try {
        const current = await getRun(meta.runId);
        if (current) {
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
        }
      } catch (err) {
        console.warn('[funnel-tracker] updateRun (complete) falhou:', err);
      }
      if (typeof userOnStepComplete === 'function') userOnStepComplete(meta);
    },

    onStepError: async (meta) => {
      // meta = { runId, stepIndex, totalSteps, item?, error, sentAt }
      try {
        const current = await getRun(meta.runId);
        if (current) {
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
        }
      } catch (err) {
        console.warn('[funnel-tracker] updateRun (error) falhou:', err);
      }
      if (typeof userOnStepError === 'function') userOnStepError(meta);
    },

    onRunFinish: async (meta) => {
      // meta = { runId, status, completed, total, finishedAt }
      try {
        await updateRun(meta.runId, {
          finishedAt: meta.finishedAt,
          completedSteps: meta.completed,
          status: meta.status,  // 'completed' | 'cancelled' | 'failed'
        });
      } catch (err) {
        console.warn('[funnel-tracker] updateRun (finish) falhou:', err);
      }
      if (typeof userOnRunFinish === 'function') userOnRunFinish(meta);
    },
  };

  return runFunnel(funnel.id, wrappedOpts);
}
