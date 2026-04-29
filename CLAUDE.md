# Zapfire — Contexto do Projeto

> Este arquivo orienta qualquer IA (Claude Code, Cursor, etc.) que for contribuir com o projeto. Leia-o por completo antes de propor qualquer mudança.

## Visão Geral

**Zapfire** é uma extensão Chrome + backend de licenciamento, clone arquitetural do **ZapVoice** (https://zapvoice.com.br), adaptado para o nicho de afiliados X1 brasileiros. O produto é parte do ecossistema IMP/MétriqAI do Melfi.

**Funcionalidade core:** turbinar o WhatsApp Web com envio de áudios pré-gravados como se fossem "ao vivo", scripts, mídias e funis automatizados — o tipo de ferramenta que afiliados usam para vender 1-a-1 no WhatsApp em escala.

**Posicionamento:** o Zapfire **NÃO se conecta ao WhatsApp via API** (nem oficial, nem Baileys, nem whatsapp-web.js). Ele é uma **extensão Chrome** que injeta código no `web.whatsapp.com` do próprio usuário. A partir do Sprint 3.5 o envio usa diretamente a API interna do WA (Store hijacking via WA-JS + módulos nativos) — **invisível, sem abrir chats, funcional pra múltiplas conversas em paralelo**.

**Arquitetura completa (3 apps):**
- `/extension` — extensão Chrome
- `/backend` — API Node/Fastify + PostgreSQL (licenciamento, webhook, painel)
- `/web` — painel Next.js do assinante (gerenciar chave, ver pagamentos, resetar vínculo)

**Gateway de pagamento:** **Kirvano** (exclusivo). Webhook cria user + subscription + chave automaticamente; cliente recebe email Resend com magic link pra configurar senha no painel.

**Repositório Git:** https://github.com/CaioGobbi/zapfire (privado). Branch principal: `main`.

**URLs em produção (Sprint 7):**
- **Backend**: `https://zapfire-production.up.railway.app` (Railway + Postgres managed)
- **Painel**: `https://zapfire-five.vercel.app` (Vercel + Next.js 14)
- **Privacy policy**: `https://zapfire-five.vercel.app/privacy` (pública, usada pra submissão CWS)
- **CWS listing**: `https://chromewebstore.google.com/detail/zapfire-%E2%80%94-superpoderes-no/nnmdjgepomoiongkabkmjnpccbpkdnmb` — distribuído como **unlisted** (sem busca pública); link só vai pelo email pós-checkout
- **Domínio real `zapfire.com.br`**: ainda não comprado — Sprint 8 faz a migração

**Versão atual da extensão**: `0.2.0` (zip pronto pra publicar em `extension/dist/zapfire-extension-0.2.0.zip`).

## Stack

### Backend (`/backend`)
- **Runtime:** Node.js 20+ (ES Modules)
- **Framework HTTP:** Fastify 4
- **ORM:** Prisma 5 (migrations em `prisma/migrations/`)
- **Banco:** PostgreSQL 18 (local em `localhost:5432`, db `zapfire`)
- **Deps principais:** `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cookie` v9, `zod`, `bcrypt`, `jsonwebtoken`, `resend`, `pino-pretty` (dev)
- **Porta:** 3000 em dev
- **Scripts:** `npm run dev` (watch), `db:migrate`, `db:seed`, `db:studio`

### Painel Web (`/web`) — Sprint 4
- **Framework:** Next.js 14.2 (App Router) + TypeScript + Tailwind
- **UI:** shadcn/ui (button, card, dialog, input, table, tabs, skeleton, sonner…)
- **State:** `zustand` (access token em memória, **nunca** em localStorage)
- **Ícones:** `lucide-react` 0.469
- **Porta:** 3001 em dev (`next dev -p 3001`)
- **Deploy alvo:** Vercel (Sprint 7)
- **Auth:** JWT access 15min (em memória) + refresh opaco 30d (cookie HttpOnly `zf_refresh`, SameSite=Lax, path `/api/v1/account`). Rotação a cada `/refresh`. `bootstrapSession()` no mount tenta refresh pra recuperar a sessão pós-reload

### Extensão (`/extension`)
- **Manifesto:** V3, múltiplos content_scripts (ISOLATED + MAIN worlds)
- **JS:** Vanilla (sem React no popup/sidebar/quickbar/manager, decisão explícita pra facilitar ofuscação futura)
- **Estilo:** Dark/cypherpunk (preto `#0a0a0a` + vermelho neon `#ff3b30` + branco) — identidade visual da IMP
- **Componentes:**
  - `background/service-worker.js` — auth, deviceId persistente, heartbeat, rota `ZF_OPEN_MANAGER`
  - `content/content.js` — ISOLATED world em `web.whatsapp.com`. Orquestra auth, monta sidebar iframe + quickbar iframe, faz bridge entre iframes e injected, mostra toast/confirm global, renderiza indicador piscante
  - `main-world/injected.js` — **MAIN world** em `web.whatsapp.com`. Acessa `window.require` do WA (Metro bundler) pra chamar módulos nativos. Carrega junto com o WA-JS
  - `vendor/wppconnect-wa.js` — WA-JS bundle (~500KB), expõe `window.WPP` com API de envio invisível
  - `vendor/opus/` — opus-media-recorder (polyfill de MediaRecorder com saída OGG Opus real, pro PTT ter waveform correto)
  - `lib/storage.js` — wrapper IndexedDB (items + funnels + meta)
  - `lib/sender.js` — envio via DOM (fallback pra quando não tem JID; usado pra envios avulsos)
  - `lib/funnel-engine.js` — executor de funis com delays, cancelamento, lock de envio serializado entre runs paralelos
  - `sidebar/` — iframe chrome-extension, **5 tabs** (Funis, Mensagens, Áudios, Mídias, Ativos) com ícones SVG, cards colapsados (click pra expandir), runner de funil
  - `quickbar/` — **iframe horizontal injetado dentro do `<footer>` do WA Web**. Lista flat de chips clicáveis em ordem funil → mensagens → áudios → mídias. Click envia pro chat aberto
  - `manager/` — aba dedicada com **dashboard "Tudo"** (welcome + stats), **list view compacta** por tipo, editor de funil com **sub-modal tabbed** pra adicionar steps (custom select com busca), conversão OGG de áudio no upload, export/import JSON
  - `popup/` — login/logout + botão "Abrir gerenciador"

## Arquitetura de Autenticação (O CORAÇÃO DO SISTEMA)

Replica o modelo do ZapVoice:

1. Usuário paga na **Kirvano** → webhook `POST /api/v1/webhooks/kirvano` cria User + Subscription + `AccessKey` (UUID hex 32 chars) + `EmailToken` MAGIC_LINK
2. Resend envia email com chave + link pro painel (`/primeiro-acesso?token=…`). Cliente configura senha via magic link, já cai logado no painel (sessão JWT).
3. Cliente instala a extensão, cola a chave no popup
4. Extensão lê o número do WhatsApp Web via `localStorage['last-wid-md']` (formato `554187056242:94@c.us`, extraímos `554187056242`)
5. Primeiro uso: backend faz **BIND** — `access_keys.boundPhone = phone`. A partir daí, a chave SÓ funciona naquele número
6. Toda revalidação compara número atual com `boundPhone`. Divergência → bloqueia
7. Até 4 dispositivos simultâneos no mesmo número (campo `plan.maxDevicesPerKey`)
8. Cliente pode gerenciar no painel: ver dispositivos, **resetar bind 1×/mês**, ver pagamentos e histórico de validações
9. Renovação via Kirvano → webhook `SUBSCRIPTION_RENEWED` estende `currentPeriodEnd`. Se falhar → entra em **período de graça de 3 dias** (extensão funciona com warning); após o grace → `EXPIRED`, bloqueia.

**Importante:** toda validação crítica é SERVER-SIDE. O client é burro, só pergunta "posso?" pro backend. Qualquer check no client é acessório.

### Endpoints atuais (prefixo `/api/v1`)

**Extensão (chave ↔ validate):**
- `POST /auth/validate` — `{ keyValue, phone, deviceId, chromeVersion? }`. Valida, faz bind se for primeiro uso, registra device. Retorna `warning: "GRACE_PERIOD"` + `daysLeft` + `graceEndsAt` quando a assinatura venceu faz ≤3 dias. Passado o grace, marca EXPIRED (lazy) e nega. Rate 30/min/IP.
- `GET /auth/heartbeat` — header `X-Zapfire-Key`. Checagem leve, usada periodicamente pela extensão.

**Webhook Kirvano (Sprint 4 ETAPA 3):**
- `POST /webhooks/kirvano` — header `X-Kirvano-Token`. Trata: `SALE_APPROVED`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_EXPIRED`, `SALE_REFUNDED`, `SALE_CHARGEBACK`, `PIX_*`. Idempotência via `Payment.kirvanoSaleId`. Token errado/ausente → 401, qualquer outro erro → 200 (evita retry infinito da Kirvano). Rate 120/min/IP. Ver `docs/kirvano-webhook.md`.

**Painel web (Sprint 4 ETAPA 4) — prefixo `/api/v1/account`:**

| Público | Autenticado (Bearer JWT) |
|---|---|
| `POST /magic-link-request` (5/min/IP, anti-enumeration) | `GET /me` |
| `POST /consume-magic-link` — seta senha e já loga | `GET /subscription` (inclui info de grace) |
| `POST /login` — 5/min/IP + 10/h/email | `GET /keys` · `GET /keys/:id/devices` |
| `POST /refresh` — cookie-only, rotaciona | `POST /keys/:id/reset-bind` — 1×/mês |
| `POST /logout` — revoga refresh | `GET /payments` (cursor) · `GET /validations` |

**Outros:**
- `GET /health` — healthcheck.

## Modelagem do Banco (10 tabelas)

Definida em `backend/prisma/schema.prisma`. Resumo:

- **users** — assinantes + admins (roles: CUSTOMER, AFFILIATE, ADMIN). bcrypt direto. Campos Sprint 4: `emailVerified`, `passwordSetAt`
- **plans** — catálogo. Sprint 4 populou: `monthly_v1` (R$47) e `annual_v1` (R$395). `monthly_x1` legado ainda existe
- **subscriptions** — relação user × plan + status. Sprint 4: `kirvanoSaleId`, `kirvanoStatus`, `gracePeriodEndsAt`, `gatewayProvider: "kirvano"`
- **access_keys** — UUID hex 32 chars. Sprint 4: `resetCount30d`, `resetCount30dResetAt`, `lastResetAt` (self-service reset 1×/mês)
- **key_devices** — dispositivos ativos (limite 4)
- **validation_logs** — cada `/auth/validate` logada
- **payments** — cada cobrança/renovação. Sprint 4: `kirvanoSaleId @unique` (idempotência), `paidAmountCents` (rename de `amountCents` via `@map`), `nfIssued`, `nfIssuedAt`
- **audit_logs** — `key.bound`, `bind.reset`, `subscription.created`, `subscription.renewed`, `key.reset_self`, `key.reset_blocked`, `webhook.error`, `user.password_set`…
- **email_tokens** (Sprint 4) — `MAGIC_LINK` | `PASSWORD_RESET`. Guarda só `tokenHash` (SHA-256). Expira em 7d
- **refresh_tokens** (Sprint 4) — sessões do painel. 30d. Guarda só hash, revoga + rotaciona a cada `/refresh`

Valores monetários SEMPRE em centavos (`Int`), mesmo padrão do PayT usado no MétriqAI.

## Arquitetura de Envio (Sprint 3.5) — LEIA ANTES DE MEXER

Sistema roda em **4 contextos JS distintos** comunicando via `postMessage`:

```
┌─────────────────────────────────────────┐   ┌─────────────────────────────────────────┐
│  sidebar.js                             │   │  quickbar.js                            │
│  (iframe, chrome-extension:// origin)   │   │  (iframe DENTRO do <footer> do WA,      │
│  IndexedDB compartilhado com manager    │   │   chrome-extension:// origin)           │
│  Dona dos activeRuns Map (funis ativos) │   │  Chips clicáveis pra envio rápido       │
└─────────────────────────────────────────┘   └─────────────────────────────────────────┘
            ↕ window.parent.postMessage                       ↕ window.parent.postMessage
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  content.js                                                                          │
│  (ISOLATED world, web.whatsapp.com)                                                  │
│  Acesso a chrome.* APIs                                                              │
│  Bridge entre iframes e injected                                                     │
│  Renderiza toast global, confirm modal, indicador piscante                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
            ↕ window.postMessage
            ↕ (filtrado por __zf_source)
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  injected.js                                                                         │
│  (MAIN world, web.whatsapp.com)                                                      │
│  Acesso a window.require, window.WPP                                                 │
│  SEM chrome.* APIs                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
            ↕ direct call
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  WA-JS (WPP) + módulos nativos do WA                                                 │
│  Envia msgs diretamente pelo protocolo                                               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Roteamento atual de envios:**

| Tipo | Função | Path |
|---|---|---|
| Texto (com JID) | `WAWebSendTextMsgChatAction.sendTextMsgToChat` | nativo |
| Texto (sem JID) | DOM via `lib/sender.js` | fallback |
| Imagem/Vídeo/Arquivo (com JID) | `WPP.chat.sendFileMessage` | WA-JS |
| Imagem/Vídeo/Arquivo (sem JID) | DOM via paste/drop/input | fallback |
| Áudio (com JID) | `WPP.chat.sendFileMessage({isPtt: true})` com OGG pré-convertido | WA-JS + opus-media-recorder |
| Áudio (sem JID) | DOM via paste | fallback |

**Captura de JID**: primeiro tenta `WPP.chat.getActiveChat()._serialized` (via injected), fallback pro DOM scraping do `[aria-selected="true"]` em `#pane-side`.

### Protocolos de mensagens

**content ↔ injected** (window.postMessage, mesmo window, worlds diferentes):
```js
// content → injected
window.postMessage({
  __zf_source: 'content',
  type: 'ZF_API_SEND_TEXT' | 'ZF_API_SEND_FILE' | 'ZF_API_GET_ACTIVE_CHAT' | 'ZF_API_PING',
  requestId: '<uuid>',
  ...payload
}, '*');

// injected → content
window.postMessage({
  __zf_source: 'injected',
  type: 'ZF_API_RESPONSE',
  requestId: '<uuid>',
  result: {...}
}, '*');
```

**sidebar ↔ content** (via window.parent.postMessage):
```js
// sidebar → content
{
  type: 'ZF_SEND_TEXT' | 'ZF_SEND_MEDIA' | 'ZF_SEND_AUDIO'
      | 'ZF_GET_CHAT_ID' | 'ZF_OPEN_MANAGER' | 'ZF_CLOSE_SIDEBAR'
      | 'ZF_QUERY_CHAT_STATE' | 'ZF_SWITCH_CHAT'
      | 'ZF_TOAST' | 'ZF_CONFIRM' | 'ZF_ACTIVE_RUNS_CHANGED',
  requestId,
  jid?, ...payload
}

// content → sidebar
{ type: 'ZF_RESPONSE', requestId, result }
{ type: 'ZF_CHAT_STATE', isOpen, chatName }
{ type: 'ZF_RUN_FUNNEL_FROM_QB', funnelId }    // forwarded from quickbar
{ type: 'ZF_FOCUS_ACTIVITY' }                   // indicador clicado
```

**quickbar ↔ content**: mesmo protocolo que sidebar (content.js aceita mensagens dos 2 iframes). Quickbar adiciona:
```js
// quickbar → content
{ type: 'ZF_QB_RUN_FUNNEL', funnelId }          // delega run pro sidebar (dono dos activeRuns)
{ type: 'ZF_TOAST', message, toastType }
```

**sidebar broadcast de runs ativos** (pra content mostrar indicador na conversa):
```js
// sidebar → content (sempre que state.activeRuns muda)
{ type: 'ZF_ACTIVE_RUNS_CHANGED', jids: ['5511...@c.us', '...'] }
```

## O Que Já Está Funcional

### Sprint 1 + 2 (backend + auth)
- Backend rodando localmente (PostgreSQL 18 local + Fastify)
- Popup com telas de login + status
- Service worker com heartbeat periódico via `chrome.alarms`
- Fluxo end-to-end de **bind** testado: cola chave → valida → trava no número → mostra status
- Seed cria plano "Mensal X1" (R$ 97/mês, 4 devices) + usuário admin + chave de teste

### Sprint 3 (UI + envios)
- **Storage IndexedDB** (`lib/storage.js`): items + funnels + meta, export/import JSON
- **Sidebar iframe** em chrome-extension:// com 5 tabs (ordem: Funis, Mensagens, Áudios, Mídias, Ativos), ícones SVG stacked, cards colapsados com click-pra-expandir
- **Layout responsivo**: sidebar empurra o conteúdo do WA ao abrir (não cobre)
- **Quickbar iframe** injetada dentro do `<footer>` do WA Web — chips horizontais flat (funis/mensagens/áudios/mídias) com ícones coloridos por tipo
- **Envio avulso** (botão "Enviar" em cards ou chip da quickbar): funciona pra texto, imagem, vídeo, arquivo, áudio
- **Manager em aba dedicada**:
  - Dashboard na tab "Tudo": welcome com nome do usuário + 5 stat cards coloridos (Funis/Mensagens/Áudios/Mídias/Documentos), cada um clicável pra navegar
  - List view compacta nas outras tabs (só badge colorido + nome, click abre edição)
  - Botão `+ Novo` contextual (muda label conforme a aba: "+ Nova mensagem", "+ Novo áudio", etc)
  - Editor de funil com lista de steps + botão `+ Adicionar item` que abre sub-modal
  - Sub-modal "Adicionar item" com tabs (Mensagem/Áudio/Mídia/Documento), custom select com barra de busca, delay em min+seg
  - Modal de edição com fields contextuais por tipo (mensagem: só texto; áudio: só arquivo; mídia: arquivo+legenda)
  - Export/import backup JSON
- **Funnel engine**: delays cancelláveis com live countdown, progresso ao vivo, múltiplos funis paralelos, lock de envio serializado
- **Confirm dialog** ao cancelar funil (modal centralizado no viewport, não nativo)
- **Toast global** no content script (top-center) — usado por sidebar e quickbar
- **Indicador piscante** na conversa do WA quando tem funil ativo pra ela (círculo vermelho com "Z", pulsa via CSS keyframes). Click abre sidebar na tab Ativos

### Sprint 3.5 (Store hijacking / envio invisível)
- **WA-JS (WPP) integrado** no MAIN world — fornece `WPP.chat.sendFileMessage`, `WPP.chat.sendVoiceMessage`, `WPP.chat.getActiveChat`
- **Módulos nativos do WA capturados via `require()`**: `WAWebSendTextMsgChatAction`, `WAWebChatCollection`, `WAWebWidFactory`
- **Bridge 4 mundos** via postMessage com marcadores `__zf_source`
- **Texto invisível**: `sendTextMsgToChat(chat, text)` direto, sem abrir conversa
- **Mídia invisível**: `WPP.chat.sendFileMessage` pra imagem/vídeo/arquivo
- **Áudio invisível como PTT**: conversão MP3/WAV → OGG Opus real (via opus-media-recorder) no upload no manager, salva como OGG no IndexedDB; envio usa `isPtt: true` → WA renderiza com waveform detalhado no remetente E destinatário
- **Paralelismo real**: múltiplos funis pra conversas diferentes enviando ao mesmo tempo, sem abrir chats, sem UI visível mudar

### Sprint 4 — COMPLETO (ciclo comercial + painel + banners + gate)

**Backend (ETAPAs 1–5):**
- **Schema**: 2 tabelas novas (`email_tokens`, `refresh_tokens`), novos campos de integração Kirvano e grace period, 2 planos comerciais (`monthly_v1`, `annual_v1`). Migration `sprint4_auth_payments` aplicada
- **Utilities**: `lib/tokens.js` (SHA-256 de plaintext, nunca armazena cru), `lib/jwt.js` (HS256, 15min, aud/iss estritos), `lib/kirvanoParser.js` (BRL→centavos, SP UTC-3→UTC, event map, resolvePlanCode), `lib/resend.js` (modo **mock** loga no console se `RESEND_API_KEY` vazio — perfeito pra dev)
- **Webhook Kirvano**: `services/kirvanoService.js` + `routes/webhooks.js`. Idempotência por `kirvanoSaleId`, sempre 200 após auth (evita retry loop). Emails HTML inline-styled de boas-vindas/renovação/cancelamento/chargeback
- **Auth painel**: `middleware/authGuard.js` + `routes/account.js` com 11 endpoints. Access JWT 15min, refresh opaco 30d em cookie HttpOnly `zf_refresh` (SameSite=Lax, path `/api/v1/account`). Rate limit por IP + por email no `/login` (10/hora). Anti-enumeration em `/magic-link-request`. Bcrypt fake hash pra timing-constant
- **keyService ampliado (SEM reescrever)**: `validateKey` agora devolve `warning: "GRACE_PERIOD"` + `daysLeft` + `graceEndsAt` quando vencida ≤3d; marca `EXPIRED` (lazy) passado o grace. Novo método `resetBind(keyId, userId)` com limite 1 reset a cada 30d (rolling window), ownership check, remove todos os devices

**Painel web (ETAPA 6) — Next.js 14 em `/web`:**
- **Infra auth client**: `lib/api.ts` (fetch com auto-refresh em 401, singleton de refresh pra evitar race), `lib/authStore.ts` (zustand em memória), `lib/auth.ts` (login/consume/logout/bootstrapSession)
- **Layouts**: `(public)` centralizado com marca Z + `(app)` com sidebar 220px (Dashboard/Assinatura/Dispositivos/Histórico)
- **Páginas**:
  - `/login` — email+senha, trata `PASSWORD_NOT_SET` (usuário ainda não consumiu magic link) com mensagem específica
  - `/primeiro-acesso` — 2 modos: com `?token=` configura senha e loga; sem token, form de pedir novo link
  - `/dashboard` — KeyCard (chave em grupos de 8 hex, botão copy), SubscriptionCard, BindCard (número mascarado `+55 (11) *****-4321`), banners contextuais (grace/expired/blocked)
  - `/assinatura` — plano + preço + próxima cobrança + botão "Gerenciar na Kirvano" (link externo) + último pagamento
  - `/dispositivos` — número vinculado + tabela de dispositivos + modal de confirmação do reset-bind com regras
  - `/historico` — tabs Pagamentos (paginado por cursor) + Validações (50 recentes, útil pro user detectar pirataria)
  - `/not-found` — 404 customizada com marca
- **Estética**: paleta cypherpunk mapeada em HSL pros tokens shadcn (`--background: 0 0% 4%`, `--primary: 4 100% 59%`…). Cores por tipo expostas como `zf-accent`, `zf-type-text`, `zf-type-audio`, etc
- **Bugs resolvidos durante a build**:
  - `@fastify/cookie` v10 incompatível com Fastify 4 → v9
  - lucide-react 1.9.x (antigo) → 0.469 (moderno com LayoutDashboard, CreditCard, etc)
  - API wrapper mandava `Content-Type: application/json` mesmo sem body → Fastify rejeitava `POST /refresh` com `FST_ERR_CTP_EMPTY_JSON_BODY` → só seta CT quando há body
  - Cookie `SameSite=Strict` bloqueando bootstrap → `Lax`

**Extensão (ETAPA 7):**
- **`extension/lib/grace-banner.js`** (novo) — helpers compartilhados: `readLicenseState`, `subscribeLicenseState` (observa `chrome.storage.onChanged`), `canSend`, `isBlocked`, `isInGrace`, `renderBannerInto`. Injeta CSS do banner 1× no documento. Exporta constante `PANEL_URL` (TODO Sprint 7: templating por build)
- **service-worker** — após cada `validateKey` (sucesso OU erro), salva `chrome.storage.local.zf_license_state = { code, warning, graceEndsAt, daysLeft, phone, lastCheckedAt }`. Logout limpa tudo. Zero mudança na lógica de bind/device
- **sidebar/quickbar/popup** — cada contexto faz `subscribeLicenseState(cb)`, repinta banner + desabilita botões de envio quando `isBlocked`. Gate de 1 linha no topo dos handlers de send/run. Sidebar tem o banner completo (grace amber + blocked red); quickbar só mostra banner compacto em estado bloqueado (espaço apertado); popup tem banner dentro do card de status + badge reativo
- **content.js** — único ponto tocado: estados bloqueados "recuperáveis pelo painel" (`EXPIRED`, `WRONG_PHONE`, `BLOCKED`) agora montam a sidebar mesmo assim, pro banner fazer o seu trabalho. `INVALID_KEY`/`NETWORK_ERROR` seguem com banner fixo de topo

**Docs (ETAPA 8):**
- `docs/kirvano-webhook.md` — schema + payloads de exemplo + how-to-test local (curl + ngrok) + idempotência
- `docs/email-templates.md` — 5 templates (boas-vindas, renovação, cancelamento, chargeback/refund, magic link): variáveis, estrutura, observações comportamentais, modo mock vs real, débito técnico

### Sprint 7 — COMPLETO (build system + deploy Railway + deploy Vercel + CWS prep)

**Build system da extensão (ETAPA 1):**
- `extension/build.mjs`: script Node que copia `extension/*` → `dist/extension/`, reescreve `config.js` com URLs de prod (vindas de `ZF_API_BASE` e `ZF_PANEL_URL` env vars), atualiza `host_permissions` do `manifest.json`, minifica JS com esbuild (bundle:false, format:esm, target:chrome120), gera `.zip` pronto pra Chrome Web Store
- Pasta `vendor/` (WA-JS + opus) NÃO é minificada — código de terceiros preservado
- `extension/config.js` (novo): exporta `API_BASE` + `PANEL_URL`. Commitado com defaults localhost (dev loads direto sem build)
- `extension/package.json` (novo): só dev-deps (esbuild ^0.24, archiver ^7). `npm run build` executa o pipeline
- `service-worker.js` e `lib/grace-banner.js` agora importam URLs do `config.js` (refactor puro, valores iguais)
- **Escolha consciente**: esbuild minify em vez de `javascript-obfuscator`. Ofuscação pesada arrisca rejeição CWS; minify é policy-compliant

**Backend Railway (ETAPA 2):**
- `backend/Dockerfile`: Node 20-slim + OpenSSL (dep do Prisma). Build copia package-lock, instala deps, gera Prisma client. CMD roda `prisma migrate deploy` antes de `node src/server.js`
- `backend/railway.json`: force builder DOCKERFILE (Railway default Railpack falhou no monorepo), healthcheck `/health`, restart ON_FAILURE 10x
- `backend/.dockerignore`: exclui node_modules, .env, cookies.txt, git
- Root Directory configurado na UI como `backend` — essencial senão Railpack/Docker tenta buildar do repo root
- Deploy: Postgres plugin provisionado, `DATABASE_URL` linkada via reference, env vars setadas (JWT_SECRET, KIRVANO_WEBHOOK_TOKEN, PANEL_BASE_URL, PANEL_ORIGINS, ADMIN_*, RESEND_*, NODE_ENV=production, HOST=0.0.0.0)
- Seed rodou via `DATABASE_URL=<public-url> npm run db:seed` local (Railway internal hostname não resolve fora da rede deles — usar `DATABASE_PUBLIC_URL` pro one-off)
- `docs/deploy-railway.md`: guia de 10 passos cobrindo criação do projeto, Postgres plugin, env vars, validação com curl, troubleshooting, custos

**Painel Vercel (ETAPA 3):**
- `web/next.config.mjs`: `eslint.ignoreDuringBuilds: true` — várias flags de estilo (`@typescript-eslint/no-explicit-any`, `no-unused-vars`) bloqueavam build de prod. Fica pra cleanup pass, não afeta runtime
- `web/app/(public)/primeiro-acesso/page.tsx`: `useSearchParams()` agora wrapped em `<Suspense>` (Next 14 exige pra páginas com querystring dinâmica)
- `web/app/fonts/`: deletados arquivos Geist órfãos
- Deploy: Root Directory = `web`, env `NEXT_PUBLIC_API_URL` = URL do Railway /api/v1
- `docs/deploy-vercel.md`: guia de import, env vars, validação, troubleshooting (CORS, cookies em HTTPS, etc)

**Bug fixes durante integração:**
- Backend CORS agora normaliza trailing slash (browser manda Origin sem `/`, user pode ter colado URL com `/` no env var — strict equality falhava silenciosamente)

**Integração extensão ↔ prod (ETAPA 4):**
- `extension/manager/manager.js` + `.html`: botão "Minha conta" no topbar abre `PANEL_URL/dashboard` em nova aba (URL vem do config.js via build)
- Build prod da extensão gerou `dist/zapfire-extension-0.1.0.zip` (415 KB) com URLs de Railway/Vercel
- Teste end-to-end em prod: popup cola chave → valida contra Railway → sidebar/quickbar aparecem → envio funciona → admin vê o bind no painel Vercel

**Chrome Web Store prep (ETAPA 5):**
- `web/app/(public)/privacy/page.tsx`: política de privacidade pública em 10 seções (LGPD-aware). Explicita que conteúdo criado (scripts/áudios/mídias) fica APENAS no IndexedDB local, servidor nunca acessa
- `docs/chrome-web-store-submission.md`: guia completo pra submeter:
  - Textos prontos pra colar: nome, summary (132 chars), description longa, single-purpose policy
  - Justificativa de CADA permissão (CWS rejeita se faltar): storage, activeTab, scripting, alarms, host_permissions, content_scripts
  - Data usage disclosure checkbox-by-checkbox
  - Checklist de assets (screenshots e promo tile ainda pendentes)
  - Passo-a-passo da submissão no dev console + motivos comuns de rejeição

### Sprint 6 — COMPLETO (backoffice admin + Resend bounce tracking)

**Backend (ETAPA 1–3):**
- `middleware/requireAdmin.js` — preHandler que extende `authGuard`, re-checa `role=ADMIN` no banco (defesa em profundidade contra token stale)
- `routes/admin.js` com prefixo `/api/v1/admin` (tudo gated por `[authGuard, requireAdmin]`):
  - **Leitura**: `GET /stats` (users/keys/subs counts, inGrace, MRR), `GET /users` (paginado + search), `GET /users/:id` (detalhe completo com keys+devices+subs+payments+validations+audit), `GET /keys` (lista global)
  - **Ações em chaves**: `POST /keys/:id/reset-bind` (força, bypassa 1×/mês), `/unlock-reset` (zera counter), `/block` + `/unblock`
  - **Ações em subscriptions**: `POST /subscriptions/:id/extend` + `/set-status` + `/change-plan` (promover/rebaixar — Sprint 5 ETAPA A)
  - **Ações em users**: `POST /users/:id/promote` (muda role) + `/set-password` (admin define senha) + `/grant-key` (cria sub+chave nova) + `/send-magic-link` (gera+envia novo link)
  - **Cortesia completa**: `POST /admin/grant-access` — cria/anexa user + sub manual + chave + opcional magic link. UI versão do `scripts/grant-access.js`
  - Todas registram audit_logs com `userId` do admin + metadata completo (valores antes/depois)
- Seed atualizado: admin recebe `passwordSetAt` + `emailVerified` na criação, evita `PASSWORD_NOT_SET` no login direto

**Painel admin (ETAPA 4) — route group `/web/app/(admin)/`:**
- Layout próprio com sidebar separada (Dashboard/Usuários/Chaves/Emails), badge "ADMIN" abaixo do logo, link pra voltar pro painel do assinante
- Gate duplo: (1) auth via bootstrapSession, (2) `user.role === 'ADMIN'` (senão tela "Acesso restrito")
- Pages:
  - `/admin` — 6 StatCards (users total/active, keys total/active/blocked, subs active/canceled/expired, in grace, MRR aproximado, revenue 30d + signups 7d)
  - `/admin/usuarios` — lista paginada por cursor com search email/nome
  - `/admin/usuarios/:id` — header com role badge + flags + botão "Mudar role". Tabs (Chaves, Assinaturas, Pagamentos, Validações, Audit). Cada KeyCard tem botões pra reset-bind/unlock-reset/block/unblock. SubCard tem extend + set-status
  - `/admin/chaves` — lista global com search por prefixo hex/email/label + filtro de status
  - `/admin/emails` — filtros por deliveryStatus (Todos/Bounces/Spam/Falhou/Entregues), tabela clickable
- Link "Backoffice admin" adicionado ao rodapé da sidebar do assinante, visível só quando `user.role === 'ADMIN'`

**ETAPA 5 — Kirvano offer_id (visibilidade read-only):**
- `kirvanoParser.getOfferMappings()` exporta as Sets atuais
- `GET /api/v1/admin/kirvano-mapping` mostra mappings + planos (sem edição — edit ainda requer redeploy)

**ETAPA 6 — Resend bounce tracking:**
- **Schema**: `EmailToken` ganha `resendEmailId`, `deliveryStatus`, `deliveryUpdatedAt`. Migration `sprint6_email_tracking` aplicada
- **Send side**: `kirvanoService` (welcome email) e `account.js` (magic link) capturam o `id` retornado pela Resend e persistem em `EmailToken.resendEmailId` com `deliveryStatus='sent'`
- **Webhook**: `POST /api/v1/webhooks/resend` com auth header `X-Zapfire-Resend-Token` (env `RESEND_WEBHOOK_TOKEN`). Mapeia eventos (`email.sent|delivered|bounced|complained|failed`) → deliveryStatus, ignora opened/clicked. Sempre 200 após auth (anti retry loop). Em bounce/complained/failed, cria audit log
- **Admin UI**: página `/admin/emails` lista tudo com filtros, banner alerta quando tem bounces, link do destinatário navega pro user

### Sprint 5 — COMPLETO (Funnel Tracking + Relatórios + Daily Report)

Feature do plano **Pro** que rastreia leads que chegaram ao final de funis monitorados, com card no dashboard, tab "Relatórios" filtravel e entrega automática no próprio WhatsApp do usuário. 100% client-side (zero backend) — só `plan.features.tracking` e `plan.features.dailyReport` vêm do `/auth/validate`. Doc completa em [`docs/sprint5-tracking.md`](docs/sprint5-tracking.md).

**Storage (ETAPA A):**
- IndexedDB bumpado v1→v2 com store nova `funnel_runs` + 4 indexes (funnelId_startedAt, status_startedAt, leadJid, startedAt)
- Schema do `funnels` ampliado com 4 campos opcionais (`trackingEnabled`, `trackingLabel`, `notifyOnComplete`, `dailyReportEnabled`). Itens antigos lerão com defaults via `withFunnelDefaults` — sem migration explícita
- API: `addRun`, `getRun`, `updateRun`, `listRuns(filters)`, `deleteRun`, `deleteRunsOlderThan(ms)` (cursor pra retention 90d)

**Engine + tracker (ETAPA A):**
- `funnel-engine.js` ampliado com 4 hooks opcionais (`onRunStart`, `onStepComplete`, `onStepError`, `onRunFinish`) — invocados em try/catch, lógica de send/lock/cancel/delay intacta
- `funnel-tracker.js` (NOVO) — wrapper `runFunnelWithTracking(funnel, target, opts)`. Se `!trackingEnabled`, passthrough direto pro `runFunnel` (zero ruído). Se tracking ativo, encadeia hooks pra escrever em `funnel_runs`
- **Mutex por runId via `chainWrite`** — corrige race condition observada em prod onde múltiplos `onStepComplete` paralelos sobrescreviam o status='completed' do `onRunFinish`. Garante ordem: addRun → step1 → step2 → ... → finish
- `reconcileOrphanRuns()` no startup do manager — recupera runs zumbis pre-fix (allStepsDone mas status='running') marcando como completed retroativamente; runs >24h sem terminar viram failed

**Backend + gate por plano (ETAPA A):**
- Seed atualizado: `monthly_v1`/`annual_v1`/`monthly_x1` recebem `FEATURES_FREE` (tracking: false). Plano novo `pro_v1` (R$97 placeholder) com `FEATURES_PRO` (tracking + dailyReport + maxMonitoredFunnels: 10)
- `/auth/validate` já retornava `plan.features` (descoberto na exploração — não foi necessário mexer)
- service-worker salva `data.data.plan?.features` em `chrome.storage.local.zf_plan_features` após cada validate. Manager observa via `chrome.storage.onChanged` e reage
- Botão "Mudar plano" no SubCard do `/admin/usuarios/:id` (endpoint `POST /admin/subscriptions/:id/change-plan` + `ChangePlanDialog`) — pra promover/rebaixar testes sem precisar Prisma Studio. Audit log com snapshot de features antes/depois

**Manager UI (ETAPA A + B):**
- Editor de funil ganha seção colapsável "Monitoramento" (toggle + sub-checkboxes pra notify/daily + input "Nome no relatório"). Free user vê tudo desabilitado com badge "Pro"; click no toggle bloqueado abre `modal-upgrade-pro`
- Indicador discreto de tracking ativo no card de funil (sidebar via `.card-track-badge` + manager via `.list-track-badge`) — SVG bar-chart na cor `--type-funnel`
- Card "Funis Monitorados (Hoje)" no dashboard "Tudo" com 3 estados: Free preview, Pro sem tracking ativo (CTA), Pro com dados (lista funis + barras horizontais + total + "Ver relatório completo →")
- Tab "Relatórios" nova entre "Funis" e "Mensagens" com filtros (Período: Hoje/7d/30d, Funil: Todos/lista) + lista agrupada por funil em `<details>` colapsáveis + botões "Abrir conversa" (foca tab WA + `WPP.chat.openChatBottom`) e "Enviar relatório agora pro meu WhatsApp"
- Funis órfãos (deletados depois) preservados como grupo "(apagado)"

**Daily report automático (ETAPA C):**
- Modal "Configurar entrega automática" com 4 modos (`disabled`, `fixed` HH:MM, `immediate`, `every4h`) + checkbox list dos funis monitorados
- Config salva em IndexedDB `meta('reports.delivery')` (canonical) + espelhada em `chrome.storage.local.zf_reports_delivery` (pro SW ler rápido)
- service-worker: `setupDeliveryAlarm(config)` cria/limpa alarm `zf_daily_report` com `when: nextOccurrenceOf(HH:MM), periodInMinutes: 1440` (fixed) ou `periodInMinutes: 240` (every4h). `bootstrapDeliveryAlarm()` no `onStartup`/`onInstalled`/load do SW
- `processScheduledDelivery()` quando alarm dispara: lê config + runs do IndexedDB direto via `storage.js` import, gera texto via `generateReportText`, despacha via `chrome.tabs.sendMessage` pra WA Web tab. Sem tab? salva `zf_pending_report` (content.js consome no init)
- Modo `immediate` é hook no `funnel-tracker.onRunFinish` — quando completed E funil incluído na config, manda `window.parent.postMessage('ZF_SEND_REPORT_TO_SELF')` pro content.js (não usa alarm)
- `lib/report-template.js` (NOVO) com `generateReportText`/`generateImmediateText`/`groupRunsByFunnel` compartilhados entre manager + SW + tracker
- content.js helper `sendTextToSelf(text)` reusado por 3 entry points: `ZF_SEND_REPORT_FROM_MANAGER` (chrome.runtime), `ZF_DELIVER_REPORT_FROM_SW` (chrome.runtime), `ZF_SEND_REPORT_TO_SELF` (window message do tracker)
- `processPendingReportIfAny()` chamado no fim do `init()` bem-sucedido — entrega relatórios que ficaram queued enquanto WA Web estava fechado

**Retention 90d:** `deleteRunsOlderThan(now - 90 dias)` no startup do manager (background, não bloqueia init)

### Pós-Sprint 5 — melhorias contínuas (pré-CWS submission)

Pequenas mudanças commitadas após o Sprint 5 fechar, antes de submeter pra Chrome Web Store. Não viraram sprint próprio mas vale documentar:

**QuickSearch — busca rápida no input do WA via `/`** (commits `07c67d5` + `20f2b2a`):
- User digita `/` no campo de mensagem do WA Web → overlay flutuante aparece com lista de items + funis filtrados pelo texto após o `/`. ↑↓ navega, Enter dispara, Esc fecha. Após enviar, o `/comando` é apagado do input via `execCommand('selectAll' + 'delete')`
- Estilo Slack/Notion/Discord — atalho natural sem precisar abrir sidebar/quickbar/manager
- **Arquitetura cross-context**: content.js (origin web.whatsapp.com) NÃO tem acesso ao IndexedDB da extensão (origin chrome-extension://). Solução: índice (id + name + type, sem blobs) é "pushado" pela sidebar via `postMessage('ZF_QS_INDEX_PUSH')` ao content.js, que mantém cache local. Refresh on-demand quando overlay abre se cache > 30s
- Funis disparam via `ZF_QS_RUN_FUNNEL` → sidebar.handleRunFunnel (mesma rota dos cards de funil). Items via `ZF_QS_SEND_ITEM` → sidebar pega blob completo + dispatch via callParent (texto, áudio, mídia, file)
- Listener input + keydown em capture phase no document, filtrado por `isWaMessageInput` (só dispara dentro de `#main footer` — exclui search box de contatos)
- Tudo inline em content.js (~350 linhas) pra não precisar adicionar content_script novo no manifest

**Card de Ativos clicável** (commit `42ac7bb`):
- Na tab "Ativos" da sidebar, durante execução de funil, a linha "→ Para: lead" virou button clicável
- Click abre o chat do lead no WA Web via mesma rota da tab Reports (`WPP.chat.openChatBottom` no injected.js)
- Útil pra acompanhar conversa em tempo real sem buscar manualmente
- Novo case `ZF_OPEN_CHAT_BY_JID` no listener window de content.js

**Indicador de funil trava no #main em qualquer layout** (commit `7137d24`):
- Bug observado: a "bolinha Z" às vezes vazava pra fora do área de chat (ficava na lista de conversas ou fora do viewport) quando user redimensionava janela ou WA reorganizava layout
- Causa: posição (top/left fixed) só recalculada quando chat MUDAVA. Mudanças de layout sem mudança de chat (resize, drawer abrindo, painel info do contato) não atualizavam
- Fix: 3 mecanismos idempotentes — `ResizeObserver` no `#main`, `window.resize`, `window.scroll` (capture). Todos chamam `repositionIndicator()` que pega rect atual. Boundary check: se `#main` some, esconde via `display: none` em vez de coordenada lixo

**ZF_API_OPEN_CHAT no injected.js** (parte do commit `d84e6ec` da ETAPA B do Sprint 5, mas vale notar):
- Caso novo no injected: `WPP.chat.openChatBottom(jid)` → permite navegação ativa entre chats (pra "Abrir conversa" da tab Reports e do card Ativos)
- O `switchToChat` legado (content.js) só DETECTA chat aberto — WA Web bloqueia clicks sintéticos no DOM, então a única rota viável de navegação programática é a API interna do WA via WPP

**cws-assets/ separado de extension/assets/** (commit `c416cc9`):
- 9 PNGs (screenshots, promo tiles, designs do CWS) que estavam em `extension/assets/` foram movidos pra `cws-assets/` na raiz
- Antes do move, build do zip dava 2.7 MB (empacotando os PNGs irrelevantes pra runtime). Após move: voltou pra ~436 KB
- `extension/assets/` mantém só os 3 ícones reais da extensão (icon-16/48/128.png)

### Pós-Sprint 7 — pré-CWS submission (UX polish + bug fixes)

Bloco focado em deixar o produto pronto pra primeira submissão na Chrome Web Store. Versão atual: **0.2.0**. Build prod em `extension/dist/zapfire-extension-0.2.0.zip` (~438 KB).

**Distribuição CWS (commits `a4b425f` + `b694e06`):**
- Estratégia: extensão entra como **unlisted** no CWS — não aparece em busca, link só vai pelo email pós-checkout. Protege contra "pirataria" sem precisar de domínio Workspace
- Removidos os 2 botões "Instalar extensão" da landing pública (`web/app/page.tsx` hero + footer) + constante `CHROME_WEB_STORE_URL` placeholder + import `Chrome` do lucide
- `web/app/(app)/dashboard/page.tsx` KeyCard agora tem botão "Instalar extensão no Chrome" (variant="outline", w-full) apontando pra URL canônica `https://chromewebstore.google.com/detail/zapfire-%E2%80%94-superpoderes-no/nnmdjgepomoiongkabkmjnpccbpkdnmb` (sem `?authuser=…&hl=…` que são query params do user atual). Fluxo natural: vê chave → instala extensão → cola chave
- `extension/popup/popup.html` "Assine aqui" agora aponta pra `https://zapfire-five.vercel.app` (era `zapfire.com.br` que ainda não existe)

**Painel — sidebars sticky + chave mascarada + admin set-email (commits `c5e72fc` + `6e6ea84`):**
- Layouts `(app)` e `(admin)`: aside agora é `sticky top-0 self-start h-screen overflow-y-auto`. Continua visível durante scroll de conteúdo longo (dashboard, tabelas de histórico, lista de usuários). Antes esticava com a página
- Dashboard `KeyCard` mostra a chave mascarada por default (`•••••••• •••••••• •••••••• ••••••••` — 4 grupos de 8 bullets, mesmo layout do `formatKey`). Botão de olho (Eye/EyeOff) revela. Copiar funciona escondida ou revelada (sempre copia o valor real)
- `web/components/ui/password-input.tsx` (NOVO) — wrapper compartilhado que adiciona toggle Eye/EyeOff a todo `<Input type="password">`. Usado em login, primeiro-acesso, e dialog de credenciais do admin
- Admin user detail: botão "Definir senha" virou "Credenciais" e abre dialog único com **2 seções independentes** (trocar email + definir senha), cada uma com seu próprio botão de aplicar — UX cleaner que ter 2 botões no header
- Backend: novo `setUserEmail({ userId, email })` em [grantService.js](backend/src/services/grantService.js) (validação de formato + unicidade + diferença do atual; revoga refresh tokens; emailVerified=true) + endpoint `POST /api/v1/admin/users/:id/set-email` com auditLog `admin.user.email_changed` (códigos: `EMAIL_IN_USE` → 409, `USER_NOT_FOUND` → 404, `BAD_INPUT` → 400, `SAME_EMAIL` → 400)

**Manager — sidebar grande + step tabs com ícones + presença em funis (commits `83273a4` + `c5e72fc` + `ab7b5a8` + `fb58c55` + `a0d9e97`):**
- Sidebar do manager: `--sidebar-w 220 → 260px`, items grandes (padding 14×16, gap 14, radius 10), font 16/600, ícones 22×22 via CSS (sobrepõe os 16×16 inline). Texto e ícone usam a cor do tipo o tempo todo (estilo ZapVoice — Funis vermelho, Mensagens azul, Áudios roxo, Imagens/Vídeos amber, Arquivos rosa). Active state usa bg colorido pelo tipo (`--type-XXX-bg`) + weight 700, no lugar do `--accent-glow` genérico que pintava tudo de vermelho
- Step tabs no editor de funil (modal "Editar item"): bolinhas coloridas (`menu-dot`) viraram **ícones SVG do tipo** (mesmo set da sidebar) na cor do tipo. Active state também ganhou bg/borda na cor do tipo
- Áudio em funil — delay editável + presença "gravando" durante waiting:
  - Step modal: ao selecionar item de áudio no picker, delay min/seg pré-preenchem com a duração do próprio áudio (default sensato; usuário pode sobrescrever)
  - Engine ([funnel-engine.js](extension/lib/funnel-engine.js)): item agora é looked-up ANTES do delay, e `phase: 'waiting'` carrega `{ item }` no payload (antes só tinha `delayMs`). Permite que quem escuta `onProgress` reaja ao tipo
  - Sidebar `onRunProgress` no `phase: 'waiting'`: dispara `ZF_SET_PRESENCE` com `kind=typing` pra texto, `kind=recording` pra áudio. Duração da presença = `delayMs` do step (mín 1.5s, máx 60s). Mídia/arquivo: nada
  - injected.js novo case `ZF_API_SET_PRESENCE` mapeia pra `WPP.chat.markIsComposing` / `markIsRecording` / `markIsPaused`
  - content.js nova bridge `ZF_SET_PRESENCE` (sidebar → injected via `callInjectedApi`)
  - **Standalone (cards/quickbar/quicksearch) NÃO usa presença** — comportamento exclusivo de funis, conforme pedido
  - Resultado: contato vê "digitando…" / "gravando áudio…" durante a espera do step inteiro; mensagem chega exatamente quando a presença expira — sem dobra de espera

**Manager — toasts + confirmações + spinner (commits `fb58c55` + `26939b5` + `b98bf02`):**
- Toast: bumpado pra 15px/600, padding 14×20, borda esquerda 4px na cor, duração 4.2s pra success (era 2.8s pra todos). Usuário leigo precisa enxergar
- Save toasts type-specific: `"✓ Áudio salvo com sucesso"`, `"✓ Vídeo salvo com sucesso"`, etc — `TYPE_LABELS` map em `saveItemFromModal`. Backup também ganhou `"✓ Backup baixado/importado"`
- Toast no **top-layer via popover API**: `showModal()` cria stacking context separado e qualquer `z-index` do DOM normal fica atrás. Solução: `<div popover="manual">` + `showPopover()`/`hidePopover()`. CSS sobrepõe o UA stylesheet do popover (`inset:0; margin:auto`) com `top:auto; left:auto; margin:0` pra manter posição bottom-right
- `window.confirm()` virou modal custom: novo `<dialog id="modal-confirm">` + helper `confirmModal({ title, body | bodyHtml, confirmLabel?, cancelLabel? })` que retorna `Promise<boolean>`. `body` aceita texto multi-linha (cada `\n` vira `<p>`); `bodyHtml` dá controle total (usado no "Apagar TUDO" que tem lista). Substitui as 4 chamadas existentes (deletar item, deletar funil, "Apagar TUDO" + "Tem certeza absoluta?")
- Spinner durante conversão de áudio: `dropzone` agora tem 2 estados internos (`#dropzone-default` + `#dropzone-loading`). Quando chega um MP3/WAV pra converter pra OGG, mostra spinner roxo + "Convertendo áudio para o formato do WhatsApp…", `pointer-events: none` no dropzone, save disabled. Toast final `"✓ Áudio convertido — XX KB"` confirma. Antes ficava 5-10s sem feedback visual

**Bug fixes (commits `1d0865c` + `391acd9`):**
- Colapsável "Monitoramento" no editor de funil não escondia o body: `display: flex` na `.tracking-body` ganhava do `[hidden]` (mesma armadilha do `.field[hidden]` já documentada). Fix em 1 linha: `.tracking-body[hidden] { display: none !important }`
- "Apagar tudo" não disparava: race no event `close` do `<dialog>` reutilizado em sequência (double-confirm). Em alguns Chromes o close event do primeiro `.close()` disparava async e era capturado pelo listener da segunda invocação — resolvia `false` antes do user clicar, abortando o fluxo. Fix: trocado event `close` por `cancel`. `cancel` só dispara em ESC do user, não em `.close()` programático — não vaza entre invocações

## Decisões Técnicas Já Tomadas (não refazer sem motivo)

### Sprint 1-2
- **bcrypt direto** (não usar passlib, nem argon2, nem outras libs)
- **Extração de número:** `localStorage['last-wid-md']` é o método principal. `IndexedDB wawc/user` NÃO contém o JID do usuário logado (são dados genéricos key-value)
- **Chave no formato UUID v4 sem hífens** (`^[a-f0-9]{32}$`) — compatibilidade visual com ZapVoice
- **Manifest V3 com `chrome.alarms`** (NÃO esquecer `"alarms"` em `permissions` — bug já resolvido no passado)
- **Sem React no popup/sidebar/quickbar/manager** — vanilla JS facilita ofuscação futura
- **IDs de chave geradas com `crypto.randomUUID().replace(/-/g, '')`**
- **`host_permissions` inclui `http://localhost:3000/*`** em dev

### Sprint 3
- **Sidebar como iframe** na origem `chrome-extension://`, não injeção direta no DOM do WA — isso permite compartilhar IndexedDB com o manager (mesma origin)
- **Quickbar também como iframe** (mesma origem) injetada dentro do `<footer>` do #main do WA — footer cresce pra comportar input + quickbar, flui com o layout nativo do WA sem overflow
- **Armazenamento tudo local no IndexedDB do lado chrome-extension** (DB name `zapfire_db`). Zero backend storage. Privacidade máxima
- **Funnel engine no contexto da sidebar** (iframe) — fechar sidebar NÃO para funis (iframe persiste no DOM). Quickbar delega runs pra sidebar via `ZF_QB_RUN_FUNNEL` pra centralizar o `activeRuns` Map
- **Sends serializados globalmente via Promise chain** (`sendChain` no funnel-engine). Delays rodam em paralelo, ato físico de envio é sequencial
- **Campos `tags` e `folder` removidos da UI do manager** — storage.js ainda suporta pra retrocompat, mas UI simplificou. Cada tipo tem seus próprios fields (mensagem: texto; áudio: arquivo; mídia: arquivo+legenda)
- **Fix conhecido do `[hidden]`**: `.field[hidden] { display: none !important }` e `.tab-badge[hidden] { display: none !important }` — `* { margin: 0 }` e `display: flex/inline-block` sobrescrevem o comportamento padrão do atributo `hidden`

### Sprint 3.5
- **Dois content_scripts em ISOLATED + MAIN**: ISOLATED (content.js) tem `chrome.*`, MAIN (injected.js) tem `window.require`/`window.WPP`
- **WA-JS (wppconnect-wa.js) carregado ANTES do injected.js** via `content_scripts` com `world: "MAIN"`. Lista de JS é executada em ordem
- **Texto via módulos nativos** (não WA-JS), mídia/áudio via WA-JS — texto é simples, vale evitar overhead
- **Áudio sempre convertido pra OGG Opus no upload** (não no envio) — user espera 1x por arquivo, depois envios são instantâneos
- **opus-media-recorder (UMD) carregado em `manager.html`** via `<script src>` normal. Worker usa `chrome.runtime.getURL` pra paths do WASM
- **CSP do extension_pages atualizado** pra `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'` — necessário pro WASM do opus-media-recorder
- **Captura de JID via WPP.chat.getActiveChat** (mais confiável que DOM) — fallback pro DOM se WPP não responder
- **Limpeza de boolean prefix** dos data-id do WA (`true_` / `false_`) quando captura via DOM — prefixo muda quando chat recebe mensagem
- **DOM sender mantido como fallback** em `lib/sender.js` pra casos sem JID (ex: usuário tenta Enviar antes do WPP carregar)

### Sprint 4 (ciclo comercial + painel)
- **Gateway único = Kirvano** (não Pagar.me/Eduzz/Guru como cogitado antes). Exclusividade simplifica webhook + evita abstrações prematuras
- **Preços Sprint 4**: Mensal R$47 (`monthly_v1`) + Anual R$395 (`annual_v1`, ≈30% off sobre 12× mensal)
- **Email = Resend**. Modo mock automático quando `RESEND_API_KEY` vazio — loga email no console e retorna `{ok: true, mockMode: true}`. Zero mudança no caller pra dev vs prod
- **Magic link antes de senha**: cliente NÃO tem senha até consumir o link. Usuário novo = `passwordSetAt: null`. Login direto com senha retorna `PASSWORD_NOT_SET` nesse caso. Email `MAGIC_LINK` expira em 7d. Só o **hash SHA-256** vai pro banco; plaintext só vive no email e no URL
- **Sessão híbrida**: access JWT 15min (stateless, body da response, memória do cliente) + refresh opaco 30d (stateful, cookie HttpOnly `zf_refresh`, hash no banco, rotaciona a cada /refresh). `bootstrapSession()` no mount do painel troca cookie por access
- **Cookie `SameSite=Lax`** (não Strict). Strict bloqueava o bootstrap em alguns fluxos de F5 mesmo sendo same-site (`:3001` ↔ `:3000`)
- **CORS no backend com callback de origin** + `credentials: true`. Aceita `chrome-extension://*` + `PANEL_ORIGINS` (default `PANEL_BASE_URL`). Echo do origin específico (wildcard não funciona com credentials)
- **Webhook responde SEMPRE 200 após auth** (exceto token errado → 401). Erros internos vão pro `audit_logs` com action `webhook.error`. Motivo: Kirvano retenta em 5xx — retry loop sobrecarrega e mascara o problema
- **Idempotência do webhook** via `Payment.kirvanoSaleId @unique`. Mesmo saleId 2× é no-op
- **Grace period = 3 dias fixos.** Configurado em `keyService.js` (`GRACE_DAYS = 3`). Dentro do grace: `/validate` retorna SUCCESS com `warning: "GRACE_PERIOD"`. Passado: marca EXPIRED (lazy) e nega
- **Reset bind self-service = 1×/30d (rolling window).** Campo `resetCount30dResetAt` zera quando passa de 30d da última janela. Limite excedido → `RESET_LIMIT` (cliente contata suporte — admin resolve manual)
- **Mock bcrypt em login sem user**: compara hash fake pra tempo-constante (evita timing attack de enumeration). Mesmo sem user, a request demora igual
- **Rate limit no /login**: 5/min/IP (via `@fastify/rate-limit` config) + 10/hora/email (in-memory Map). Suficiente pra single-server; se virar multi-server, migrar pra Redis
- **Access token NUNCA em localStorage** — só em memória (zustand). Trade-off: F5 precisa chamar /refresh. Mitigação: `bootstrapSession()` faz isso transparentemente no mount
- **shadcn tokens mapeados pra HSL da paleta Zapfire** em `web/app/globals.css`. Cores por tipo viram utility `bg-zf-accent`, `text-zf-type-text`, etc (Tailwind config em `web/tailwind.config.ts`)
- **`@fastify/cookie` v9** (v10+ requer Fastify 5). Mantém compat com nossa Fastify 4.29
- **Painel em porta 3001** (não 3000) pra não conflitar com o backend. Script é `next dev -p 3001`
- **`.env.example` sempre com placeholders** — nunca commitar token real. `cookies.txt` (residue de curl -c/-b) no `.gitignore`

### Sprint 7 (build + deploy)
- **Esbuild minify, não `javascript-obfuscator`** — ofuscação pesada arrisca rejeição do CWS policy review. Minify (encurta locais, preserva exports) é o limite seguro
- **Build replace de URLs via `config.js`** em vez de placeholder-replace. Source commitado com localhost defaults, `build.mjs` sobrescreve no dist/. Dev loads direto sem build
- **Dockerfile em vez de Nixpacks/Railpack** no Railway: builder auto-detect falhou no monorepo, Dockerfile é determinístico (controla Node version, OpenSSL, CMD). Railway service Root Directory = `backend` é essencial
- **Railway injeta DATABASE_URL via reference**: `${{Postgres.DATABASE_URL}}`. URL usa `postgres.railway.internal` que só resolve de dentro da rede Railway. Pra seed one-off local, usar `DATABASE_PUBLIC_URL` (proxy TCP público)
- **`eslint.ignoreDuringBuilds: true`** no painel Vercel. Várias flags de estilo (explicit-any, unused-vars) bloqueavam build de prod. Separar build de lint é padrão na indústria; ESLint continua rodando via `npm run lint` manual/CI
- **CORS com trailing-slash tolerance**: normaliza ambos os lados antes da comparação. User pode colar `https://painel.com/` no env, browser envia `https://painel.com` sem barra
- **Content do usuário nunca no servidor**: scripts/áudios/mídias ficam em IndexedDB local. Essa é decisão fundacional (Sprint 3) mas virou ponto de venda na Privacy Policy e no store listing — zero acesso a dados sensíveis do cliente
- **Screenshots e promo tile 440x280 ainda pendentes** pra submissão CWS

### Sprint 5 (tracking + relatórios)
- **"Chegou ao final do funil" = todos os steps disparados COM SUCESSO pelo Zapfire**. Não rastreamos resposta/ack/leitura — quem viu o último step (na nossa visão) completou. Decisão fundacional pra evitar dependência de signals do WA que mudam frequentemente
- **Tracking opt-in por funil via `trackingEnabled` toggle** — funis sem o flag fazem passthrough direto pelo `runFunnel` (zero IndexedDB write, zero overhead). Evita poluir o storage com runs não pedidos
- **Mutex por runId no `funnel-tracker.js` (`chainWrite`)** — corrige race condition observada em prod onde `onStepComplete` async stale sobrescrevia `onRunFinish` (status='completed' virava 'running'). Garante ordem strict addRun→steps→finish. `reconcileOrphanRuns()` no startup recupera runs já zumbis
- **`runFunnel` ampliado SEM mudar assinatura** — adicionados 4 hooks opcionais (`onRunStart`/`onStepComplete`/`onStepError`/`onRunFinish`) no objeto opts existente. Lógica de send/lock/cancel/delay 100% intacta
- **Retention 90d hardcoded** — `deleteRunsOlderThan(now - 90d)` no startup do manager. Configurável via `meta` no futuro se virar pedido
- **Daily report 100% client-side via `chrome.alarms`** — backend não sabe nada sobre runs. Alarm name único `zf_daily_report` (modo determina `when`/`periodInMinutes`), reagendado em `onStartup`/`onInstalled`/load do SW pra cobrir reload da extensão
- **Modo `immediate` NÃO usa alarm** — é hook no `funnel-tracker.onRunFinish` que postMessages pro content.js. Mais rápido e mais natural (tracker já roda no contexto certo)
- **Config canonical em IndexedDB `meta('reports.delivery')`, espelhada em `chrome.storage.local.zf_reports_delivery`** — manager escreve nos 2; SW lê do chrome.storage (rápido, sem precisar abrir IndexedDB toda hora). Read divergência é aceitável pq lastSentAt é não crítico
- **Pending report**: SW salva `zf_pending_report` quando WA Web está fechado, content.js consome no `init()` pós-validação. Texto é pré-gerado — se user fica dias sem abrir, recebe relatório com timestamps antigos (aceitável)
- **`generateReportText` compartilhado em `lib/report-template.js`** — manager + SW + tracker importam dali. Limita 10 leads/funil pra não estourar tamanho de mensagem WhatsApp
- **Plano `pro_v1` preço placeholder R$97** — definir antes de criar oferta na Kirvano. Quando virar definitivo, atualizar seed + adicionar offer_id em `kirvanoParser.js` (PRO_OFFER_IDS)
- **Heartbeat NÃO atualiza `plan.features`** — só `/auth/validate` faz. Promover Pro requer F5/relogin pra UI refletir. Aceitável pq é evento raro
- **`maxMonitoredFunnels: 10` documentado mas não validado client-side** — fica pra quando alguém atingir o limite

### Pós-Sprint 5 (melhorias contínuas)
- **QuickSearch usa cache no content via postMessage da sidebar** — content.js (origin web.whatsapp.com) não tem acesso ao IndexedDB da extensão. Sidebar broadcasta índice (id+name+type, sem blobs) no init via `ZF_QS_INDEX_PUSH`. Refresh on-demand quando overlay abre se cache > 30s. Items com blob são pegos pela sidebar quando despacha envio (`ZF_QS_SEND_ITEM`)
- **QuickSearch listener em capture phase** — `document.addEventListener('input'/'keydown', ..., true)`. Captura ANTES do React do WA processar, especialmente importante pra Enter/Tab/Esc não vazarem pro WA enviar mensagem indesejada
- **QuickSearch trigger só em input INTEIRO começando com `/`** — não dispara se "/" tá no meio de texto. Permite mandar literal "/algo" se user fechar overlay com Esc + Enter
- **`execCommand('selectAll' + 'delete')` pra limpar input do WA** — deprecated mas funciona em contenteditable controlado por React. É o que o WA usa internamente. Se virar problema (anos), troca pra `Selection.deleteFromDocument()`
- **Indicador de funil ativo: ResizeObserver no #main + window resize/scroll** — cobre mudanças de layout sem mudança de chat (drawer info contato, side-panel busca, modo compacto/expandido). 3 listeners idempotentes, todos chamam `repositionIndicator()`
- **`WPP.chat.openChatBottom(jid)` é a única forma confiável de navegar entre chats programaticamente** — clicks sintéticos no DOM são bloqueados pelo `isTrusted` check do WA. switchToChat legado só DETECTA chat aberto, não navega
- **cws-assets/ na raiz, não em extension/** — assets pra publicação na CWS (screenshots 1280x800, promo tiles, drafts) ficam fora do zip da extensão. Build empacota só `extension/assets/` que tem 3 ícones reais (icon-16/48/128.png). Empacotar PNGs grandes no zip dispara comentário do reviewer ("por que essa extensão tem 2.4 MB de PNGs em assets/?") e infla download dos clientes 6×

### Pós-Sprint 7 (pré-CWS submission)
- **CWS unlisted, não pública** — extensão fica unlisted no Developer Dashboard (não aparece em busca, sem ranking, link só funciona pra quem tem). Link vai pelo email pós-checkout do Resend. É proteção anti-pirataria de 1ª linha (sem precisar Google Workspace pra modo privado), e mantém a mesma URL chrome-extension:// id estável que dá pra distribuir sempre que precisar
- **Toast no top-layer via popover API**, não z-index — `<dialog>` aberto via `showModal()` cria stacking context separado em top-layer; nenhum z-index do DOM normal vence. `<div popover="manual">` + `showPopover()`/`hidePopover()` coloca o elemento no mesmo top-layer dos dialogs abertos. CSS sobrepõe o UA stylesheet (`inset:0; margin:auto`) com `top:auto; left:auto; margin:0` pra manter posição bottom-right. Chrome 114+ (manifest aponta 120+, safe)
- **Confirmações custom em vez de window.confirm** — alertbox nativa do browser não cabe no tema dark/cypherpunk e fica tosca em monitor grande. Helper `confirmModal({ title, body | bodyHtml, confirmLabel? })` retorna `Promise<boolean>`. **Cuidado**: usar event `cancel` (não `close`) pra capturar ESC, porque close pode disparar async em alguns Chromes e vazar pra próxima invocação quando o mesmo dialog é reutilizado em sequência (ex: double-confirm do "Apagar TUDO" — bug observado em prod)
- **`.tracking-body[hidden]` precisa `display: none !important`** — `display: flex` ganha do default `[hidden]`. Mesma armadilha do `.field[hidden]` documentada antes. Sempre que adicionar `display: flex/grid/inline-block` num elemento que tem `hidden` toggle, declare também a regra `[hidden] { display: none !important }`
- **Engine emite `phase: 'waiting'` com `{ item }`** — lookup do item agora acontece ANTES do delay (em vez de depois), pra que listeners de onProgress reajam ao tipo durante a espera (ex: presença "digitando"/"gravando" pro contato). Sender stays type-agnostic
- **Presença pro contato é exclusiva de funis, não envios standalone** — decisão UX: cards/quickbar/quicksearch são "envio rápido" e o usuário espera resposta imediata; mostrar "digitando..." atrasaria. Funil é simulação humana, presença faz sentido. Implementação: hook no `onRunProgress` da sidebar, dispara `ZF_SET_PRESENCE` → injected → `WPP.chat.markIsComposing/markIsRecording`. Duração da presença = `delayMs` do step (mín 1.5s, máx 60s)
- **Áudio em funil: delay defaulta pra duração do áudio mas é editável** — quando user seleciona um item de áudio no step picker, min/seg pré-preenchem com `Math.round(item.duration)`. Não escondemos o input (UX flexibility) — só damos um default sensato. A presença "gravando..." durante o delay = duração do áudio dá feeling natural de "tá gravando agora"
- **Sidebars do painel viraram `sticky top-0 self-start h-screen`** — antes esticavam com a página em rotas com conteúdo longo (histórico, lista admin de usuários). Sticky + self-start permite que o aside não estique no grid e fique fixo no topo durante scroll
- **Chave mascarada por default no painel + eye toggle** — UX defensiva contra screenshare/screenshot acidental do dashboard. Mostra `•••••••• •••••••• •••••••• ••••••••` (4 grupos de 8 bullets, mesmo layout do `formatKey`). Botão de copy continua funcionando escondida — copia o valor real
- **`PasswordInput` reutilizável com Eye/EyeOff toggle** — mesmo componente compartilhado em login, primeiro-acesso, dialog admin. Mantém `<Input>` shadcn como fonte da verdade pro estilo, só envelopa com state interno `show` que alterna entre `type="password"` e `type="text"`. Padding-right 10 pra acomodar o botão absoluto
- **Admin: dialog "Credenciais" combinando email + senha** — em vez de 2 botões separados ("Mudar email" e "Definir senha"), 1 botão "Credenciais" abre dialog com 2 seções independentes, cada uma com seu próprio botão de aplicar. UX mais limpa e o user-detail header já tem 4 botões (Nova chave / Credenciais / Magic link / Mudar role) — adicionar 1 a mais pioraria

## Próximos Sprints

- **Sprint 8:** Capturar screenshots + design do small promo tile (440x280). Submeter pra Chrome Web Store. Comprar domínio `zapfire.com.br`, configurar DNS (painel no Vercel como `app.zapfire.com.br`, backend no Railway como `api.zapfire.com.br`), atualizar env vars e redeploy. Verificar domínio no Resend (SPF+DKIM) pra enviar email real do `contato@zapfire.com.br`. Definir preço final do `pro_v1` + criar oferta na Kirvano + adicionar offer_id em `kirvanoParser.js` (PRO_OFFER_IDS)
- **Gatilhos por palavra-chave (Sprint futuro):** hookar mensagens recebidas via WPP/store listener; quando match, enviar resposta automática do item associado. Originalmente era "Sprint 5", virou "Sprint 5.5 ou outro" depois que Sprint 5 virou tracking

### Débito técnico conhecido
- opus-media-recorder tem ~700KB combinado (UMD + WASM) — poderia ser lazy-loaded só quando usuário abre modal de áudio
- Fallback DOM em `lib/sender.js` ainda existe — pode ser removido quando envio via API for 100% estável
- Conversão OGG bloqueia UI do manager durante o upload — desde 0.2.0 mostra spinner roxo no dropzone e desabilita save, mas o thread principal ainda trava (opus-media-recorder roda playback realtime). Async/progress real seria via worker dedicado
- `tags` e `folder` ainda no schema do IndexedDB mas sem UI — decidir entre remover do storage ou reintroduzir UI
- Rate limit por email no /login é in-memory Map — vira Redis quando for multi-server
- Kirvano `offer_id` → plano ainda é fallback por `charge_frequency`. Sprint 8: preencher `ANNUAL_OFFER_IDS` / `MONTHLY_OFFER_IDS` em `lib/kirvanoParser.js` com os IDs reais
- Backend tem 6 vulnerabilidades transitivas moderate/high no `resend`. Revisar antes de volume alto
- `audit_logs.metadata` cresce indefinidamente — precisa de política de retenção ou tabela particionada no futuro
- **ESLint desabilitado no build do Vercel** — várias flags de estilo bloqueavam build (any, unused-vars, unescaped-entities). Fazer cleanup pass quando der tempo
- **Resend webhook usa token em header**, não assinatura svix. Pra prod sério, migrar pra svix (padrão Resend)
- **Senha do Postgres Railway foi exposta em chat durante o seed inicial** — rotacionar via UI Railway (service Postgres → Settings → Rotate Password) antes de ficar produção-grave
- **Domínio não-vanity** (Railway + Vercel) no manifest + nas URLs do painel — Sprint 8 migra pra `zapfire.com.br`
- **Assets da CWS (screenshots, promo tile 440x280) ainda não capturados** — bloqueio pra submeter

## Estrutura Atual do Projeto

```
zapfire/
├── CLAUDE.md                             ← este arquivo
├── README.md
├── .gitignore                            ← ignora .env, cookies.txt, node_modules, .crx, .zip
├── docs/
│   ├── kirvano-webhook.md                ← schema + payloads + how-to-test
│   ├── email-templates.md                ← 5 templates + estrutura + modo mock
│   ├── deploy-railway.md                 ← guia 10 passos pro backend
│   ├── deploy-vercel.md                  ← guia pro painel
│   ├── chrome-web-store-submission.md    ← textos prontos + checklist + justificativas de permissões
│   ├── backup-format.md                  ← schema ZapVoice 3.0.0 + mapeamentos do import/export
│   └── sprint5-tracking.md               ← Sprint 5 — tracking + relatórios + daily report
│
├── cws-assets/                           ← screenshots + promo tiles pra Chrome Web Store
│   │                                       (separado de extension/assets/ pra não inflar o zip)
│   ├── Screenshot_1..5.png                ← 1280x800 pro listing CWS
│   ├── sidebar.png                        ← screenshot extra
│   └── Design sem nome*.png               ← drafts do promo tile 440x280
│
├── backend/                              ← Node.js + Fastify + Prisma + PostgreSQL
│   ├── .env                              ← gitignored (secrets)
│   ├── .env.example                      ← placeholders PUBLIC-SAFE
│   ├── .dockerignore                     ← exclui node_modules, .env, .git do image
│   ├── Dockerfile                        ← Sprint 7 — Node 20-slim + OpenSSL + prisma migrate deploy
│   ├── railway.json                      ← builder DOCKERFILE + healthcheck /health
│   ├── package.json
│   ├── prisma/
│   │   ├── schema.prisma                 ← 10 tabelas + 3 enums novos do Sprint 4
│   │   ├── seed.js                       ← plans monthly_x1, monthly_v1, annual_v1, pro_v1 (Sprint 5)
│   │   └── migrations/
│   │       ├── 20260424_sprint4_auth_payments/
│   │       └── 20260427_sprint6_email_tracking/
│   ├── scripts/
│   │   └── grant-access.js               ← cortesia CLI (cria user+sub+chave+magic link)
│   └── src/
│       ├── server.js                     ← registra CORS c/ callback, @fastify/cookie, routes
│       ├── lib/
│       │   ├── prisma.js                 ← singleton Prisma
│       │   ├── jwt.js                    ← sign/verify access (15min HS256) + refresh opaco
│       │   ├── tokens.js                 ← generateSecureToken + hashToken (SHA-256)
│       │   ├── resend.js                 ← sendEmail com mock mode automático
│       │   └── kirvanoParser.js          ← parseBRL, parseKirvanoDate, mapEvent, resolvePlan
│       ├── middleware/
│       │   └── authGuard.js              ← preHandler Bearer JWT pra /account/*
│       ├── routes/
│       │   ├── auth.js                   ← /auth/validate, /auth/heartbeat
│       │   ├── webhooks.js               ← /webhooks/kirvano (token + Zod + dispatch)
│       │   └── account.js                ← 11 endpoints do painel
│       └── services/
│           ├── keyService.js             ← validateKey (com grace), resetBind (self-service), resetKeyBind (admin)
│           ├── kirvanoService.js         ← handlers por evento (SALE_*, SUBSCRIPTION_*, etc)
│           └── grantService.js           ← grantAccess, setUserPassword, setUserEmail (pós-Sprint 7), grantNewKey, sendNewMagicLink
│
├── web/                                  ← Next.js 14 App Router (painel do assinante)
│   ├── .env.example                      ← NEXT_PUBLIC_API_URL
│   ├── package.json                      ← "dev": "next dev -p 3001"
│   ├── components.json                   ← config shadcn
│   ├── tailwind.config.ts                ← palette cypherpunk (zf-accent, zf-type-*)
│   ├── next.config.mjs                   ← Sprint 7: eslint.ignoreDuringBuilds=true
│   ├── app/
│   │   ├── layout.tsx                    ← RootLayout + AuthProvider + Toaster
│   │   ├── page.tsx                      ← / redireciona pra /dashboard ou /login
│   │   ├── not-found.tsx                 ← 404 branded
│   │   ├── globals.css                   ← tokens shadcn em HSL
│   │   ├── (public)/                     ← sem auth
│   │   │   ├── layout.tsx                ← centralizado + marca Z
│   │   │   ├── login/page.tsx
│   │   │   ├── privacy/page.tsx          ← Sprint 7 — LGPD policy pública (URL p/ CWS)
│   │   │   └── primeiro-acesso/page.tsx  ← 2 modos (com/sem ?token=) + Suspense
│   │   └── (app)/                        ← requer JWT (gate via bootstrapSession)
│   │       ├── layout.tsx                ← sidebar 220px STICKY + main
│   │       ├── dashboard/page.tsx        ← chave mascarada+eye toggle + botão "Instalar extensão" + sub + bind
│   │       ├── assinatura/page.tsx       ← plano + último pagamento + link Kirvano
│   │       ├── dispositivos/page.tsx     ← devices + modal reset-bind
│   │       └── historico/page.tsx        ← tabs Pagamentos + Validações
│   ├── components/
│   │   ├── AuthProvider.tsx              ← chama bootstrapSession no mount
│   │   └── ui/                           ← shadcn: button, card, input, dialog, badge, table, tabs, skeleton, sonner, password-input (pós-Sprint 7)…
│   └── lib/
│       ├── api.ts                        ← fetch wrapper + auto-refresh em 401
│       ├── authStore.ts                  ← zustand (access em memória!)
│       ├── auth.ts                       ← login/consume/logout/bootstrap
│       ├── format.ts                     ← BRL, data, maskPhone, formatKey
│       └── utils.ts                      ← cn() helper shadcn
│
└── extension/                            ← Chrome Manifest V3
    ├── manifest.json                     ← múltiplos content_scripts (ISOLATED + MAIN)
    ├── config.js                         ← Sprint 7 — API_BASE + PANEL_URL (build-replaced)
    ├── build.mjs                         ← Sprint 7 — esbuild minify + zip pra CWS
    ├── package.json                      ← Sprint 7 — devDeps (esbuild + archiver)
    ├── dist/                             ← Sprint 7 — saída do build (gitignored)
    │   ├── extension/                    ← pasta pronta pra load unpacked ou CWS
    │   └── zapfire-extension-<v>.zip     ← upload direto no CWS (~438 KB; v0.2.0 atual)
    ├── assets/ (ícones 16/48/128)
    ├── background/
    │   └── service-worker.js             ← auth, heartbeat, license state; importa API_BASE
    ├── content/
    │   └── content.js                    ← ISOLATED world em web.whatsapp.com
    ├── main-world/
    │   └── injected.js                   ← MAIN world, ponte pra WPP + módulos nativos
    ├── lib/
    │   ├── storage.js                    ← IndexedDB wrapper (4 stores na v2)
    │   ├── sender.js                     ← envio via DOM (fallback)
    │   ├── funnel-engine.js              ← executor de funis paralelos (+4 hooks Sprint 5)
    │   ├── funnel-tracker.js             ← Sprint 5 — wrapper c/ mutex + reconcile + immediate
    │   ├── report-template.js            ← Sprint 5 — generateReportText + groupRunsByFunnel
    │   ├── backup.js                     ← export/import compatível com ZapVoice 3.0.0
    │   └── grace-banner.js               ← Sprint 4 — banner de grace + gate de envio
    ├── sidebar/                          ← iframe (320px fixed à direita)
    ├── quickbar/                         ← iframe dentro do <footer> do WA
    ├── manager/                          ← aba dedicada full-screen + botão "Minha conta"
    ├── popup/                            ← login/logout + Abrir gerenciador
    └── vendor/                           ← WA-JS bundle + opus-media-recorder WASM (não minificado)
```

## Convenções de Código

- **Idioma dos comentários:** português (o usuário é brasileiro e vai manter o código)
- **Comentários em blocos `// ===` no topo de cada arquivo explicando responsabilidade**
- **Nomes de funções/variáveis em inglês**, mas **strings de UI em português**
- **Usar `async/await`**, não `.then()` em cadeia
- **Validação de request com Zod** no backend, sempre
- **Nenhum segredo hardcoded** — tudo via `.env`
- **Status HTTP coerentes:** 401 (chave inválida), 402 (assinatura expirada), 403 (chave bloqueada/número errado), 429 (limite de devices)
- **Marcadores `__zf_source`** em toda postMessage entre content ↔ injected pra filtrar ruído de outros scripts
- **Concordância de gênero nos títulos** (Nova mensagem vs Novo áudio) — usar `TYPE_GENDER` map no manager.js

## Estética/UI

### Paleta base
- `--bg: #0a0a0a` / `--bg-elevated: #141414` / `--bg-hover: #1c1c1c`
- `--border: #262626` / `--border-hover: #383838`
- `--text: #f5f5f5` / `--text-dim: #a3a3a3`
- `--accent: #ff3b30` / `--accent-glow: rgba(255, 59, 48, 0.15)`
- `--success: #10b981` / `--warning: #ff6b00` / `--danger: #dc2626`

### Cores por tipo (aplicadas consistentemente em badges, bordas esquerdas de cards, ícones, stat cards)
- **Funil**: `#ff3b30` (vermelho accent) — var `--type-funnel`
- **Mensagem (text)**: `#38bdf8` (azul ciano) — var `--type-text`
- **Áudio**: `#a855f7` (roxo) — var `--type-audio`
- **Mídia (image+video)**: `#f59e0b` (amber) — var `--type-media`
- **Arquivo (file)**: `#ec4899` (rosa magenta) — var `--type-file`

### Outros padrões
- **Tipografia:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`; monospace `'SF Mono', Menlo, monospace`
- **Raio de borda:** 6px (inputs/botões), 8px (cards)
- **Ícones:** SVG inline estilo Lucide (stroke outline, 14-22px). Cores por tipo quando relevante
- **Tom industrial/cypherpunk:** dark backgrounds, acentos vermelhos neon, zero gradientes pastel
- **Animações:** pulse (indicador de funil ativo), transform 0.15s ease-out (layouts shift)

### Layouts principais
- **Sidebar** (320px fixed à direita): 5 tabs compactas com ícone+texto empilhados, cards colapsados clique-pra-expandir, borda esquerda colorida pelo tipo
- **Quickbar** (44px, dentro do `<footer>` do WA): chips horizontais com scroll lateral, icon-only (sem texto de categoria), separadores entre grupos
- **Manager** (aba dedicada full-screen): sidebar esquerda 220px com filter items + ícones, main com dashboard OU list view
- **Modais** (`<dialog>` nativo centralizado via `margin: auto`): header + body + footer, backdrop com blur

## Integrações Existentes no Ecossistema

O Melfi opera outros produtos que compartilham infra quando faz sentido:

- **MétriqAI** — SaaS de análise de Meta Ads. Stack similar (Python/FastAPI + Postgres + Render). Webhook Pagar.me já validado lá.
- **IMP (O Improvável)** — mentorship de afiliados X1. Tem `LUKKA` (tracking) e dashboard React. Zapfire será oferecido dentro deste ecossistema.

## Dependências Externas (vendor/)

### WA-JS (`vendor/wppconnect-wa.js`)
- Licença: MIT
- Repo: https://github.com/wppconnect-team/wa-js
- Versão testada: 3.23.4
- Uso: Store hijacking do WA Web. Expõe `window.WPP` com APIs `chat.sendFileMessage`, `chat.sendVoiceMessage`, `chat.getActiveChat`
- **Risco**: atualizações do WA Web podem quebrar. Monitorar 1-2x por mês. Atualizar o bundle quando quebrar

### opus-media-recorder (`vendor/opus/`)
- Licença: MIT
- Repo: https://github.com/kbumsik/opus-media-recorder
- Uso: polyfill de `MediaRecorder` com saída OGG Opus real (Chrome nativo só exporta WebM, WA exige OGG pro PTT)
- 4 arquivos: `OpusMediaRecorder.umd.js`, `encoderWorker.umd.js`, `OggOpusEncoder.wasm`, `WebMOpusEncoder.wasm`

## Proteção Anti-Pirataria (pensar desde já)

Já implementado:
- Rate limit 30 req/min por IP
- Log de toda tentativa em `validation_logs`
- `key_devices` com limite por plano
- Bind permanente no primeiro uso
- Toda validação server-side

A implementar (Sprint 7):
- Ofuscação JS (`javascript-obfuscator`) dos arquivos da extensão antes de empacotar
- Fingerprint de device mais forte (canvas + fonts + hardware)
- Detecção de múltiplos IPs distintos pela mesma chave em janela curta
- Possivelmente: encoding das chaves no cliente antes de enviar pro backend (dificulta sniffing via rede)
