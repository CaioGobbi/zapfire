// ============================================================
// ZAPFIRE — Report Template (Sprint 5 ETAPA C)
// ============================================================
// Funções puras pra formatar o texto do relatório enviado
// no próprio WhatsApp do usuário. Compartilhadas entre:
//   - manager.js   ("Enviar relatório agora" da tab Reports)
//   - service-worker.js  (alarms automáticos: fixed, every4h)
//   - funnel-tracker.js  (modo immediate por lead)
//
// Comentários PT-BR, ES module, sem libs externas.
// ============================================================

const PERIOD_LABELS = {
  today: 'Hoje',
  '7d':  'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '4h':  'Últimas 4 horas',
};

function formatTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatToday() {
  return new Date().toLocaleDateString('pt-BR');
}

// ------------------------------------------------------------
// Texto LONGO — usado pelos modos fixed, every4h, e "Enviar agora"
// ------------------------------------------------------------
//
// Args:
//   runsByFunnel — array de { funnelId, name, runs: [...] }
//                  já agrupado pelo caller. Cada run precisa ter
//                  leadName, leadJid, finishedAt|startedAt.
//   periodKey    — 'today' | '7d' | '30d' | '4h'
//
// Limita 10 leads por funil (resto vira "+ N outros") pra não
// estourar tamanho de mensagem WhatsApp.
// ------------------------------------------------------------
export function generateReportText(runsByFunnel, periodKey = 'today') {
  const lines = [];
  const periodLabel = PERIOD_LABELS[periodKey] || 'Período';
  lines.push(`🎯 Relatório Zapfire — ${periodLabel} (${formatToday()})`);
  lines.push('');

  let totalLeads = 0;
  for (const group of runsByFunnel) {
    if (!group.runs.length) continue;
    totalLeads += group.runs.length;
    lines.push(group.name.toUpperCase());
    lines.push(`✅ ${group.runs.length} ${group.runs.length === 1 ? 'lead chegou' : 'leads chegaram'} ao final`);

    const shown = group.runs.slice(0, 10);
    for (const r of shown) {
      const name = r.leadName || (r.leadJid?.split('@')[0]) || 'Sem nome';
      lines.push(`• ${name} — ${formatTime(r.finishedAt || r.startedAt)}`);
    }
    if (group.runs.length > 10) {
      lines.push(`• + ${group.runs.length - 10} outro(s)`);
    }
    lines.push('');
  }

  if (totalLeads === 0) {
    lines.push('Nenhum lead completou funis monitorados nesse período.');
  } else {
    lines.push(`📊 Total: ${totalLeads} ${totalLeads === 1 ? 'lead completou' : 'leads completaram'} funis monitorados`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------
// Texto CURTO — modo immediate (1 mensagem por lead)
// ------------------------------------------------------------
//
// Args:
//   run — entry de funnel_runs com funnelName, leadName, leadJid,
//         finishedAt
// ------------------------------------------------------------
export function generateImmediateText(run) {
  const name = run.leadName || (run.leadJid?.split('@')[0]) || 'Sem nome';
  const phone = run.leadJid?.split('@')[0] || '';
  const time = formatTime(run.finishedAt || run.startedAt || Date.now());
  return [
    `🎯 Lead completou funil!`,
    ``,
    `Funil: ${run.funnelName || '—'}`,
    `Lead: ${name}${phone ? ` (${phone})` : ''}`,
    `Hora: ${time}`,
  ].join('\n');
}

// ------------------------------------------------------------
// Helper compartilhado — agrupa runs por funnelId mantendo ordem
// dos funis ativos. Funis órfãos (deletados) entram no fim com
// sufixo "(apagado)".
// ------------------------------------------------------------
export function groupRunsByFunnel(runs, monitoredFunnels) {
  const groups = monitoredFunnels.map((f) => ({
    funnelId: f.id,
    name: f.trackingLabel || f.name,
    runs: runs.filter((r) => r.funnelId === f.id),
  }));

  const activeIds = new Set(monitoredFunnels.map((f) => f.id));
  const orphans = new Map();
  for (const r of runs) {
    if (activeIds.has(r.funnelId)) continue;
    const k = r.funnelId;
    if (!orphans.has(k)) {
      orphans.set(k, {
        funnelId: k,
        name: (r.funnelName || 'Funil') + ' (apagado)',
        runs: [],
      });
    }
    orphans.get(k).runs.push(r);
  }
  for (const o of orphans.values()) groups.push(o);
  return groups;
}
