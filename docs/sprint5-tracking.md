# Sprint 5 — Funnel Tracking + Relatórios

> **Status**: implementado e validado em prod (2026-04-27). Feature do plano **Pro** que rastreia leads que chegaram ao final de funis monitorados, com card no dashboard, tab "Relatórios" filtravel e entrega automática no próprio WhatsApp do usuário.

## Resumo

Permite que o usuário marque funis específicos como "monitorados". Cada execução desses funis cria um `funnel_run` no IndexedDB local, registrando qual lead chegou ao final. O Pro consulta esses dados em:

1. **Card no dashboard** "Tudo" do manager — top funis do dia + total
2. **Tab "Relatórios"** dedicada — filtros de período/funil + lista por funil + botão "Abrir conversa"
3. **Entrega automática** no próprio WhatsApp do usuário — 4 modos (desativado / fixo / imediato / a cada 4h)

100% **client-side**. Nada vai pro backend exceto a flag `plan.features.tracking` que vem em `/auth/validate`.

## Decisões fundacionais

- **"Chegou ao final" = todos os steps foram disparados pro lead com sucesso**. Não rastreamos resposta, ack ou leitura. Quem completou pelo Zapfire = quem viu o último step, na nossa definição.
- **Apenas funis com `trackingEnabled: true` geram registros**. Funis sem o toggle não criam ruído no IndexedDB — passthrough direto pro `runFunnel` original.
- **Feature gated por `plan.features.tracking`**. Free user vê tudo desabilitado com badge "Pro" + modal de upgrade.
- **Retention de 90 dias** — runs com `finishedAt < now - 90d` são apagados no startup do manager. Hardcoded por agora; configurável via `meta` no futuro se virar pedido.
- **Daily report tem 3 modos + 1 imediato**:
  - `disabled` — não envia nada
  - `fixed` — 1 mensagem por dia em horário escolhido (default 18:00)
  - `every4h` — 1 mensagem a cada 4h com runs do período
  - `immediate` — 1 mensagem solo por lead que completar (não usa alarm)

## Arquitetura

### Os 5 contextos JS envolvidos

```
┌──────────────────────────────────────────────────────────────────────┐
│  manager.js (chrome-extension://...)                                 │
│  - Modal "Configurar entrega automática" (4 modos)                   │
│  - Card "Funis Monitorados (Hoje)" no dashboard                      │
│  - Tab "Relatórios" com filtros + "Abrir conversa" + "Enviar agora"  │
│  - Toggle de monitoramento dentro do editor de funil                 │
│  - Reconciliação de runs zumbis no startup                           │
└──────────────────────────────────────────────────────────────────────┘
                              ↕ chrome.tabs.sendMessage
┌──────────────────────────────────────────────────────────────────────┐
│  service-worker.js (background, MV3)                                 │
│  - chrome.alarms.create('zf_daily_report', ...) por modo             │
│  - Listener onAlarm → processScheduledDelivery()                     │
│    - Lê config + runs do IndexedDB                                   │
│    - Gera texto via report-template.js                               │
│    - chrome.tabs.sendMessage pra WA Web tab                          │
│    - Sem tab? → salva em chrome.storage.local zf_pending_report      │
│  - Reagenda alarm em onStartup, onInstalled e load do SW             │
└──────────────────────────────────────────────────────────────────────┘
                              ↕ chrome.tabs.sendMessage
┌──────────────────────────────────────────────────────────────────────┐
│  content.js (web.whatsapp.com, ISOLATED world)                       │
│  - sendTextToSelf(text) — pega selfJid via getUserPhone() existente  │
│  - 3 entry points: ZF_SEND_REPORT_FROM_MANAGER (chrome.runtime),     │
│    ZF_DELIVER_REPORT_FROM_SW (chrome.runtime),                       │
│    ZF_SEND_REPORT_TO_SELF (window message — vem do tracker)          │
│  - processPendingReportIfAny() roda no init pós-validação            │
│  - ZF_OPEN_CHAT_FROM_MANAGER → callInjectedApi('ZF_API_OPEN_CHAT')   │
└──────────────────────────────────────────────────────────────────────┘
                              ↕ window.postMessage (__zf_source filter)
┌──────────────────────────────────────────────────────────────────────┐
│  injected.js (web.whatsapp.com, MAIN world)                          │
│  - case 'ZF_API_OPEN_CHAT' → WPP.chat.openChatBottom(jid)            │
│  - case 'ZF_API_SEND_TEXT' → módulos nativos do WA (já existia)      │
└──────────────────────────────────────────────────────────────────────┘
                              ↕ window.parent.postMessage (do iframe)
┌──────────────────────────────────────────────────────────────────────┐
│  funnel-tracker.js (rodando dentro do iframe sidebar)                │
│  - runFunnelWithTracking(funnel, target, opts) — wrapper opcional    │
│  - Hooks com mutex por runId (chainWrite) garantem ordem strict:     │
│    addRun → step1 → step2 → ... → finish                             │
│  - onRunFinish(status='completed') → deliverImmediateIfApplicable    │
│    → window.parent.postMessage('ZF_SEND_REPORT_TO_SELF') se modo     │
│    'immediate' está ativo e funil incluído                           │
│  - reconcileOrphanRuns() exportada pro manager chamar no startup     │
└──────────────────────────────────────────────────────────────────────┘
```

### Storage

**IndexedDB `zapfire_db` v2** (bump da v1 sem mexer em nada existente):

| Store | Conteúdo | Indexes |
|---|---|---|
| `items` | Mensagens, áudios, mídias, arquivos (legado v1) | `type`, `createdAt`, `folder` |
| `funnels` | Funis com `trackingEnabled` etc (campos novos opcionais) | (none, keyPath) |
| `meta` | `reports.delivery` (canonical da config) + outras prefs | (none, keyPath) |
| **`funnel_runs` (NOVA)** | Cada execução de funil monitorado | `funnelId_startedAt`, `status_startedAt`, `leadJid`, `startedAt` |

**chrome.storage.local** (estado leve, lido pelo SW e UI):

| Key | Quem escreve | Quem lê |
|---|---|---|
| `zf_plan_features` | service-worker (em `validateKey` success) | manager, sidebar |
| `zf_reports_delivery` | manager (espelho do meta) | service-worker (rápido pra alarm) |
| `zf_pending_report` | service-worker (quando WA Web tá fechado) | content.js (consome no init) |

### Schema do `funnel_runs`

```js
{
  id:             string (uuid),
  funnelId:       string,
  funnelName:     string,           // snapshot p/ caso o funil seja
                                    // renomeado/deletado depois
  leadJid:        string,           // ex: "5541999999999@c.us"
  leadName:       string | null,

  startedAt:      number (ms),
  finishedAt:     number | null,

  totalSteps:     number,           // tamanho do funil quando rodou
  completedSteps: number,           // quantos disparados com sucesso

  status: 'running' | 'completed' | 'cancelled' | 'failed',

  steps: [
    { stepId, type, sentAt, success, error? }
  ]
}
```

**Status semântica**:
- `running` — ainda em execução
- `completed` — `completedSteps === totalSteps` E controller não foi cancelado
- `cancelled` — usuário clicou "Cancelar" na tab Ativos
- `failed` — passou por todos os steps mas algum falhou (item missing, send rejeitado, etc)

### Schema do `funnels` ampliado

Campos novos (todos opcionais, default false/null aplicados via `withFunnelDefaults` na leitura — sem migration):

```js
{
  // ... campos antigos: id, name, steps, createdAt, updatedAt

  trackingEnabled?:    boolean   // ativa criação de funnel_runs
  trackingLabel?:      string    // nome customizado pro relatório
  notifyOnComplete?:   boolean   // (placeholder pra futuras notificações)
  dailyReportEnabled?: boolean   // (placeholder — não usado, daily usa funnelIds da config)
  isFavorite?:         boolean   // import/export ZapVoice
}
```

## Concorrência / mutex (a parte mais sutil)

O `runFunnel` engine chama os hooks via `safeHook(fn, payload)` **síncrono sem await**. Múltiplos hooks async (`onStepComplete` x N + `onRunFinish`) rodam intercalados, fazendo read-modify-write não-atômicos no IndexedDB. **Bug observado em prod (run real)**: `completedSteps === totalSteps`, ambos steps com `success: true`, mas `status: 'running'` e `finishedAt: null` — porque `onStepComplete` lia snapshot stale e escrevia depois do `onRunFinish`, sobrescrevendo o `status: 'completed'`.

**Solução**: mutex por `runId` no `funnel-tracker.js`. Cada hook entra numa Promise chain (`chainWrite`) e espera os anteriores terminarem antes do read-modify-write. Garante ordem strict: `addRun` → `step1` → `step2` → ... → `finish`.

```js
// funnel-tracker.js (resumido)
const runWriteChains = new Map();

function chainWrite(runId, task) {
  const prev = runWriteChains.get(runId) || Promise.resolve();
  const next = prev.then(task, task);
  runWriteChains.set(runId, next.catch(() => {}));
  return next;
}
```

E `reconcileOrphanRuns()` exportada do tracker, chamada no startup do manager, recupera runs já zumbis (pre-fix) e mata zombies de >24h sem terminar.

## Fluxo end-to-end (modo "Horário fixo")

1. Pro user vai em `Manager → Reports → "Configurar entrega automática"`
2. Marca **"Horário fixo"** + **18:00** + checkbox em 2 funis monitorados → Salva
3. Manager:
   - `storage.setMeta('reports.delivery', config)` (canonical)
   - `chrome.storage.local.set({ zf_reports_delivery: config })` (mirror pro SW)
   - `chrome.runtime.sendMessage({ type: 'ZF_RESCHEDULE_DELIVERY', config })`
4. Service-worker:
   - `chrome.alarms.clear('zf_daily_report')`
   - `chrome.alarms.create('zf_daily_report', { when: nextOccurrenceOf('18:00'), periodInMinutes: 1440 })`
5. **No dia seguinte às 18:00**, alarm dispara → SW spawna
6. SW:
   - Lê `zf_reports_delivery` do `chrome.storage.local`
   - Calcula janela `since = lastSentAt || now-24h`
   - Lê `funnel_runs` filtrados por `status='completed'` + `funnelId IN config.funnelIds` + `since/until`
   - Agrupa via `groupRunsByFunnel(runs, monitoredFunnels)`
   - Gera texto via `generateReportText(grouped, 'today')`
   - Sem leads no período? Skip silencioso (mas atualiza `lastSentAt` pra não consultar de novo cedo demais)
7. SW dispara `chrome.tabs.query({ url: 'https://web.whatsapp.com/*' })`
   - **Tab aberta**: `chrome.tabs.sendMessage(tab.id, { type: 'ZF_DELIVER_REPORT_FROM_SW', text })`
   - **Sem tab**: `chrome.storage.local.set({ zf_pending_report: { text, mode, queuedAt } })`
8. Content.js handler `ZF_DELIVER_REPORT_FROM_SW` chama `sendTextToSelf(text)`:
   - `getUserPhone()` → `selfJid = phone + '@c.us'`
   - `callInjectedApi('ZF_API_SEND_TEXT', { jid: selfJid, text })`
9. Injected.js executa `WAWebSendTextMsgChatAction.sendTextMsgToChat(chat, text)` — texto chega no chat do próprio usuário
10. SW marca `lastSentAt = now` e amanhã às 18:00 dispara de novo (alarm com `periodInMinutes: 1440`)

**Pendência (caso WA Web fechado)**: quando user reabrir, `init()` valida chave + chama `processPendingReportIfAny()` que lê `zf_pending_report`, despacha via `sendTextToSelf`, e remove a chave. Best-effort: erro só loga.

## Modo "Imediato" (sem alarm)

Não usa `chrome.alarms`. Funciona via hook no `funnel-tracker.js`:

```
funnel termina → onRunFinish (status='completed') →
deliverImmediateIfApplicable(runId, funnelId) →
   Lê meta('reports.delivery')
   Se mode==='immediate' E funnelId in funnelIds:
     generateImmediateText(run)  (texto curto)
     window.parent.postMessage('ZF_SEND_REPORT_TO_SELF', { text })
content.js handler → sendTextToSelf(text)
```

Diferença do modo `every4h`/`fixed`: aqui **não passa pelo SW**, vai direto do tracker → content.js → injected. Faz sentido — o tracker já está rodando no contexto certo (iframe sidebar dentro da tab WA Web).

## Como testar local

### Setup (uma vez)

1. Aplica seed do backend pra criar `pro_v1` + `features.tracking` nos planos:
   ```bash
   cd backend
   DATABASE_URL="<DATABASE_PUBLIC_URL>" npm run db:seed
   ```
2. Promove um user pra Pro pelo painel admin: `/admin/usuarios/<id>` → tab Assinaturas → "Mudar plano" → `pro_v1`
3. Refresca extensão: `chrome://extensions` → 🔄 no card Zapfire
4. Logout + login no popup pra service-worker re-validar e salvar `zf_plan_features.tracking = true`

### Migration do schema (automática no primeiro F5)

Confere DevTools no manager → Application → IndexedDB → `zapfire_db`. Versão deve estar **2** com 4 stores: `items`, `funnels`, `meta`, `funnel_runs`.

### Cenário 1: tracking básico

1. Manager → Funis → edita um funil → expande "Monitoramento" → marca "Acompanhar leads neste funil" → Salva
2. Card do funil agora mostra **ícone de barras vermelho** ao lado do nome (sidebar e manager)
3. Dispara o funil pra um lead via sidebar
4. Quando o funil terminar todos os steps:
   - DevTools → IndexedDB → `funnel_runs` → 1 entry com `status: 'completed'`
   - Manager → tab "Tudo" → card "Funis Monitorados (Hoje)" mostra **+1**
   - Manager → tab "Relatórios" → grupo do funil expande mostrando o lead

### Cenário 2: "Abrir conversa"

1. Tab Reports → expande grupo → click **"Abrir conversa"** num lead
2. Aba do WA Web foca + chat abre direto na conversa do lead

### Cenário 3: "Enviar relatório agora"

1. Tab Reports → click **"Enviar relatório agora pro meu WhatsApp"**
2. Mensagem chega no SEU PRÓPRIO chat (você manda pra você) com texto formatado

### Cenário 4: Modo "Imediato"

1. Tab Reports → "Configurar entrega automática" → marca **Imediato** + checkbox no funil → Salva
2. Dispara o funil pra um lead novo
3. Quando funil completar → mensagem solo no seu próprio chat:
   ```
   🎯 Lead completou funil!
   Funil: 1 - APRESENTAÇÃO
   Lead: João Silva (5541...)
   Hora: 14:30
   ```

### Cenário 5: Modo "Horário fixo" / "A cada 4 horas" (acelerado)

Os alarms reais demoram horas pra disparar. Pra acelerar:

1. Configura o modo + funis incluídos no modal
2. `chrome://extensions` → "service worker (inspecionar)" → console
3. Força disparar: `chrome.alarms.create('zf_daily_report', { delayInMinutes: 0.5 })`
4. Aguarda 30s → relatório chega no chat

### Cenário 6: Pending report (WA Web fechado)

1. Configura modo `every4h`
2. Fecha TODAS as tabs do `web.whatsapp.com`
3. Console do SW: `chrome.alarms.create('zf_daily_report', { delayInMinutes: 0.5 })`
4. 30s depois: `chrome.storage.local.get('zf_pending_report')` deve ter `{ text, mode, queuedAt }`
5. Reabre `web.whatsapp.com` → após init validar a chave, mensagem chega + `zf_pending_report` é limpa

### Cenário 7: Free user (gate Pro)

1. Volta o user pra `monthly_v1` no admin → relogar pelo popup
2. Manager → editor de funil: seção Monitoramento aparece com badge **Pro** + tudo desabilitado
3. Click no toggle desabilitado → modal "Disponível no plano Pro"
4. Tab "Tudo": card "Funis Monitorados" em modo preview com badge Pro
5. Tab "Relatórios": tela centralizada com CTA upgrade

## Limitações conhecidas

- **Heartbeat NÃO atualiza features**: o `/auth/heartbeat` retorna só status, não plan.features. Promover Free → Pro requer F5/relogin pra UI refletir. Aceitável pq promoção é evento raro.
- **`isPtt` / `isPtv` / `asViewOnce` / `mentionUsers` não consumidos pelo sender ainda**. Schema só armazena. Implementação no sender fica pra iteração futura quando virar pedido real.
- **Texto do relatório limitado a 10 leads/funil** pra não estourar tamanho de mensagem WhatsApp (`+ N outros`). Configurável depois se virar pedido.
- **`maxMonitoredFunnels: 10`** no plano Pro está documentado mas **não é validado client-side ainda**. Validação fica pra quando alguém atingir.
- **Modo immediate só dispara se WA Web estiver aberto** (porque o tracker roda dentro do iframe sidebar). Funil que rolou em background sem sidebar visível não dispara — mas isso não acontece na prática (sidebar sempre tá montada quando funil roda).
- **`pendingReport` é texto pré-gerado**: se o user ficar dias sem abrir WA Web, vai receber relatório com timestamps antigos. Aceitável — alternativa seria regenerar no momento da entrega, mas adiciona complexidade pra benefício marginal.

## Arquivos novos / modificados

**Novos:**
- [`extension/lib/funnel-tracker.js`](../extension/lib/funnel-tracker.js) — wrapper com mutex + reconciliação + immediate hook
- [`extension/lib/report-template.js`](../extension/lib/report-template.js) — `generateReportText`, `generateImmediateText`, `groupRunsByFunnel`
- [`docs/sprint5-tracking.md`](sprint5-tracking.md) — esta doc

**Modificados (cirúrgicos):**
- [`extension/lib/storage.js`](../extension/lib/storage.js) — bump v2, store `funnel_runs` + indexes, `addRun`/`updateRun`/`listRuns`/`deleteRunsOlderThan`, ampliação do schema de funnel
- [`extension/lib/funnel-engine.js`](../extension/lib/funnel-engine.js) — 4 callbacks de telemetria opcionais (`onRunStart`, `onStepComplete`, `onStepError`, `onRunFinish`). Lógica de envio intacta.
- [`extension/sidebar/sidebar.js`](../extension/sidebar/sidebar.js) — troca `runFunnel` por `runFunnelWithTracking` em `handleRunFunnel` + indicador no card
- [`extension/manager/manager.html/css/js`](../extension/manager/) — modal de monitoramento, tab Reports, modal de delivery config, modal upgrade Pro
- [`extension/background/service-worker.js`](../extension/background/service-worker.js) — `chrome.alarms` setup, `processScheduledDelivery`, `bootstrapDeliveryAlarm`, `ZF_RESCHEDULE_DELIVERY` handler
- [`extension/content/content.js`](../extension/content/content.js) — handlers `ZF_OPEN_CHAT_FROM_MANAGER`, `ZF_SEND_REPORT_FROM_MANAGER`, `ZF_DELIVER_REPORT_FROM_SW`, `processPendingReportIfAny`, `sendTextToSelf` helper, window message `ZF_SEND_REPORT_TO_SELF`
- [`extension/main-world/injected.js`](../extension/main-world/injected.js) — `case 'ZF_API_OPEN_CHAT'` usando `WPP.chat.openChatBottom`
- [`backend/prisma/seed.js`](../backend/prisma/seed.js) — `FEATURES_FREE` / `FEATURES_PRO` + plano `pro_v1` (preço placeholder R$97)
- [`backend/src/routes/admin.js`](../backend/src/routes/admin.js) — `POST /admin/subscriptions/:id/change-plan` pra promover/rebaixar
- [`web/app/(admin)/admin/usuarios/[id]/page.tsx`](../web/app/(admin)/admin/usuarios/[id]/page.tsx) — `ChangePlanDialog` no SubCard

**NÃO tocados** (proibidos pelo briefing): `sender.js`, `popup`, `quickbar`, `auth.js`, `keyService.js` (apenas confirmamos que `validateKey` já retorna `plan.features`).
