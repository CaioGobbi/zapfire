# Zapfire — Contexto do Projeto

> Este arquivo orienta qualquer IA (Claude Code, Cursor, etc.) que for contribuir com o projeto. Leia-o por completo antes de propor qualquer mudança.

## Visão Geral

**Zapfire** é uma extensão Chrome + backend de licenciamento, clone arquitetural do **ZapVoice** (https://zapvoice.com.br), adaptado para o nicho de afiliados X1 brasileiros. O produto é parte do ecossistema IMP/MétriqAI do Melfi.

**Funcionalidade core:** turbinar o WhatsApp Web com envio de áudios pré-gravados como se fossem "ao vivo", scripts, mídias e funis automatizados — o tipo de ferramenta que afiliados usam para vender 1-a-1 no WhatsApp em escala.

**Posicionamento:** o Zapfire **NÃO se conecta ao WhatsApp via API** (nem oficial, nem Baileys, nem whatsapp-web.js). Ele é uma **extensão Chrome** que injeta código no `web.whatsapp.com` do próprio usuário. A partir do Sprint 3.5 o envio usa diretamente a API interna do WA (Store hijacking via WA-JS + módulos nativos) — **invisível, sem abrir chats, funcional pra múltiplas conversas em paralelo**.

**Repositório Git:** https://github.com/CaioGobbi/zapfire (privado). Branch principal: `main`.

## Stack

### Backend (`/backend`)
- **Runtime:** Node.js 20+ (ES Modules)
- **Framework HTTP:** Fastify 4
- **ORM:** Prisma 5
- **Banco:** PostgreSQL 18 (local em `localhost:5432`, db `zapfire`)
- **Deps principais:** `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `zod`, `bcrypt`, `pino-pretty` (dev)
- **Porta:** 3000 em dev
- **Scripts:** `npm run dev` (watch), `db:push`, `db:seed`, `db:studio`

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

1. Usuário paga via gateway (Pagar.me, Eduzz, Guru) → webhook cria `AccessKey` com UUID hex de 32 chars (sem hífens)
2. Usuário recebe chave por email, instala a extensão, cola a chave no popup
3. Extensão lê o número do WhatsApp Web via `localStorage['last-wid-md']` (formato `554187056242:94@c.us`, extraímos `554187056242`)
4. Primeiro uso: backend faz **BIND** — `access_keys.boundPhone = phone`. A partir daí, a chave SÓ funciona naquele número
5. Toda revalidação compara número atual com `boundPhone`. Divergência → bloqueia
6. Até 4 dispositivos simultâneos no mesmo número (campo `plan.maxDevicesPerKey`)

**Importante:** toda validação crítica é SERVER-SIDE. O client é burro, só pergunta "posso?" pro backend. Qualquer check no client é acessório.

### Endpoints atuais (prefixo `/api/v1`)

- `POST /auth/validate` — payload: `{ keyValue, phone, deviceId, chromeVersion? }`. Valida, faz bind se for primeiro uso, registra device.
- `GET /auth/heartbeat` — header `X-Zapfire-Key`. Checagem leve, usada periodicamente pela extensão.
- `GET /health` — healthcheck pra monitoramento.

Rate limit: 30 req/min por IP em `/auth/validate`.

## Modelagem do Banco (8 tabelas)

Definida em `backend/prisma/schema.prisma`. Resumo:

- **users** — assinantes + admins (roles: CUSTOMER, AFFILIATE, ADMIN). bcrypt direto, sem passlib.
- **plans** — catálogo (code, priceCents em centavos, billingCycle, maxKeys, maxDevicesPerKey, features JSON)
- **subscriptions** — relação user × plan + status de pagamento. `currentPeriodEnd` é a data de vencimento
- **access_keys** — chaves UUID hex 32 chars. `boundPhone` (null até primeiro login) + `boundAt` + `status` (ACTIVE/SUSPENDED/BLOCKED/EXPIRED)
- **key_devices** — dispositivos ativos por chave (limite de 4 no plano padrão)
- **validation_logs** — cada chamada ao `/validate` fica logada (resultado, phone tentado, IP, UA)
- **payments** — cada cobrança/renovação
- **audit_logs** — ações importantes (key.bound, bind.reset, key.blocked, etc.)

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

## Próximos Sprints

- **Sprint 4 (próximo):** Gatilhos por palavra-chave. Hookar mensagens recebidas via WPP/store listener; quando match, enviar resposta automática do item associado
- **Sprint 5:** Webhook Pagar.me + painel web do assinante (Next.js, reaproveitar stack MétriqAI)
- **Sprint 6:** Backoffice admin (ver chaves, bindar/desbindar, ver logs, promover usuário)
- **Sprint 7:** Ofuscação (`javascript-obfuscator`) dos JS da extensão, deploy Render pro backend, publicação Chrome Web Store

### Débito técnico conhecido
- opus-media-recorder tem ~700KB combinado (UMD + WASM) — poderia ser lazy-loaded só quando usuário abre modal de áudio
- Fallback DOM em `lib/sender.js` ainda existe — pode ser removido quando envio via API for 100% estável
- Conversão OGG bloqueia UI do manager durante o upload — poderia ser async/progress
- `tags` e `folder` ainda no schema do IndexedDB mas sem UI — decidir entre remover do storage ou reintroduzir UI

## Estrutura Atual do Projeto

```
zapfire/
├── CLAUDE.md                             ← este arquivo
├── README.md
├── .gitignore
├── backend/
│   ├── .env                              ← gitignored (secrets)
│   ├── .env.example
│   ├── package.json
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── seed.js
│   └── src/
│       ├── server.js                     ← entrypoint Fastify
│       ├── lib/prisma.js                 ← singleton Prisma
│       ├── routes/auth.js                ← /auth/validate, /auth/heartbeat
│       └── services/keyService.js        ← validateKey(), resetKeyBind()
└── extension/
    ├── manifest.json                     ← Manifest V3, múltiplos content_scripts
    ├── assets/
    │   ├── icon-16.png
    │   ├── icon-48.png
    │   └── icon-128.png
    ├── background/
    │   └── service-worker.js             ← auth, heartbeat, rota ZF_OPEN_MANAGER
    ├── content/
    │   └── content.js                    ← ISOLATED world em web.whatsapp.com
    ├── main-world/
    │   └── injected.js                   ← MAIN world, ponte pra WPP + módulos nativos
    ├── lib/
    │   ├── storage.js                    ← IndexedDB wrapper
    │   ├── sender.js                     ← envio via DOM (fallback)
    │   └── funnel-engine.js              ← executor de funis paralelos
    ├── sidebar/
    │   ├── sidebar.html                  ← 5 tabs com ícones SVG
    │   ├── sidebar.css                   ← dark cypherpunk + cores por tipo
    │   └── sidebar.js                    ← cards colapsados, activity Map
    ├── quickbar/
    │   ├── quickbar.html                 ← barra horizontal com chips
    │   ├── quickbar.css
    │   └── quickbar.js                   ← injetada dentro do footer do WA
    ├── manager/
    │   ├── manager.html                  ← dashboard + list view + modais
    │   ├── manager.css
    │   └── manager.js                    ← CRUD, conversão OGG, editor de funil tabbed
    ├── popup/
    │   ├── popup.html
    │   └── popup.js                      ← login + botão Abrir gerenciador
    └── vendor/
        ├── wppconnect-wa.js              ← WA-JS bundle (~500KB)
        └── opus/
            ├── OpusMediaRecorder.umd.js
            ├── encoderWorker.umd.js
            ├── OggOpusEncoder.wasm
            └── WebMOpusEncoder.wasm
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
