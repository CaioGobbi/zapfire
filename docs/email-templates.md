# Templates de Email — Zapfire

> Referência de todos os emails transacionais que o backend dispara. Os templates vivem **inline no código** (como literals HTML/texto em funções JS), não em arquivos separados. Se o volume de edição for alto ou um time de design quiser mexer sem tocar no código, virar template engine externo (eta, handlebars, ou MJML) é candidato pra Sprint 6/7.

## Provedor e modo

- **Provedor:** [Resend](https://resend.com)
- **Wrapper:** `backend/src/lib/resend.js` (exporta `sendEmail({to, subject, html, text})`)
- **Modo mock:** se `RESEND_API_KEY` estiver vazio, o wrapper **não envia nada** — só loga no console com o conteúdo do email e retorna `{ok: true, mockMode: true}`. Perfeito pra dev. Nenhum caller precisa se preocupar com isso.
- **Remetente:** env `RESEND_FROM_EMAIL` (default `"Zapfire <contato@zapfire.com.br>"`).
- **Encoding:** UTF-8.
- **Estilo:** inline via `style="..."` em cada tag (compatibilidade máxima com clientes de email — Gmail, Outlook, Apple Mail, etc. removem `<style>` blocks).

## Convenções visuais (shared)

Todos os templates do `kirvanoService.js` usam o mesmo shell e constants `EMAIL_STYLES`:

```js
const EMAIL_STYLES = {
  body: "margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,...sans-serif;color:#f5f5f5;",
  wrap: 'max-width:520px;margin:0 auto;padding:32px 24px;',
  logo: '...48x48 bg:#ff3b30 Z branco arredondado...',
  h1:   'font-size:22px;margin:16px 0 0;color:#f5f5f5;',
  p:    'font-size:15px;line-height:1.6;color:#d4d4d4;',
  dim:  'font-size:13px;color:#a3a3a3;',
  btn:  'padding:12px 28px;background:#ff3b30;color:#fff;...',
  hr:   'border:none;border-top:1px solid #262626;margin:24px 0;',
  code: "background:#141414;border:1px solid #262626;...font-family:'SF Mono',Menlo,monospace;...color:#ff3b30;",
};
```

- **Paleta:** dark cypherpunk (mesma da extensão/painel): `#0a0a0a` bg, `#ff3b30` accent, `#f5f5f5` text.
- **Largura máx:** 520px, centralizado.
- **Fonte:** stack do sistema (Apple/Segoe UI/sans-serif). Fontes custom não entregam bem em email.

## Inventário de emails

| # | Template             | Quando dispara                                                           | Arquivo                                    | Função                   |
|---|----------------------|--------------------------------------------------------------------------|--------------------------------------------|--------------------------|
| 1 | Boas-vindas          | Webhook `SALE_APPROVED` (assinante novo)                                 | `backend/src/services/kirvanoService.js`   | `sendWelcomeEmail()`     |
| 2 | Renovação            | Webhook `SUBSCRIPTION_RENEWED`                                           | `backend/src/services/kirvanoService.js`   | `sendRenewalEmail()`     |
| 3 | Cancelamento         | Webhook `SUBSCRIPTION_CANCELED`                                          | `backend/src/services/kirvanoService.js`   | `sendCancelationEmail()` |
| 4 | Chargeback/Refund    | Webhook `SALE_REFUNDED` ou `SALE_CHARGEBACK`                             | `backend/src/services/kirvanoService.js`   | `sendChargebackEmail()`  |
| 5 | Magic link (login)   | `POST /api/v1/account/magic-link-request` (assinante pede link no painel) | `backend/src/routes/account.js`            | inline no handler        |

---

## 1. Boas-vindas

**Subject:** `Bem-vindo ao Zapfire — configure sua senha`

**Variáveis interpoladas:**
- `name` — nome do assinante (do `customer.name` da Kirvano, fallback pro prefixo do email)
- `planName` — "Mensal" ou "Anual"
- `keyValue` — UUID hex de 32 chars
- `magicLinkUrl` — `${PANEL_BASE_URL}/primeiro-acesso?token=${plaintext}` (token expira em 7d)

**Corpo (texto fallback):**

```
Bem-vindo ao Zapfire!

Sua assinatura {{planName}} foi ativada.

Configure sua senha: {{magicLinkUrl}}
(expira em 7 dias)

Chave de acesso:
{{keyValue}}

Cole no popup da extensão Chrome.
```

**Corpo (HTML — estrutura):**

1. Logo "Z" centralizado + título "Bem-vindo ao Zapfire"
2. Parágrafo "Olá <strong>{name}</strong>, sua assinatura <strong>{planName}</strong> foi ativada."
3. Frase "Pra começar, configure sua senha clicando abaixo:"
4. Botão vermelho "Configurar senha" → `magicLinkUrl`
5. "Esse link expira em 7 dias."
6. Separador
7. "Sua chave de acesso:" + bloco monoespaçado vermelho com `keyValue`
8. "Cole essa chave no popup da extensão Chrome após instalá-la."
9. Separador
10. "Dúvidas? Responda este email."

**Observações:**
- Este é o único email que inclui o **token plaintext** — a partir do consume, o banco só armazena o hash SHA-256.
- `emailVerified` do User fica em `false` até o consume. Se o user tentar `/login` antes de consumir, recebe `PASSWORD_NOT_SET` com mensagem orientando a usar o link.

---

## 2. Renovação

**Subject:** `Zapfire — renovação confirmada`

**Variáveis:**
- `name`
- `amountCents` — valor pago em centavos (4700 ou 39500)
- `nextChargeDate` — Date da próxima cobrança (já em UTC)

**Corpo (texto):**

```
Renovação confirmada — pagamento de R$ XX,XX. Próxima cobrança: DD/MM/YYYY.
```

**Corpo (HTML):**

1. Logo + "Renovação confirmada"
2. "Olá <strong>{name}</strong>, recebemos o pagamento de <strong>{amountBRL}</strong>."
3. "Próxima cobrança: <strong>{nextChargeDateBR}</strong>."
4. Subtexto "Sua chave continua a mesma."

**Observações:**
- Formatação BRL usa `toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'})`.
- Data em `toLocaleDateString('pt-BR')` → `DD/MM/YYYY`.
- Não reenvia chave (o user já tem).

---

## 3. Cancelamento

**Subject:** `Zapfire — assinatura cancelada`

**Variáveis:**
- `name`
- `expiresAt` — Date do `currentPeriodEnd` (acesso mantido até aqui)

**Corpo (texto):**

```
Cancelamento processado. Acesso mantido até DD/MM/YYYY.
```

**Corpo (HTML):**

1. Logo + "Assinatura cancelada"
2. "Olá <strong>{name}</strong>, seu cancelamento foi processado."
3. "Você mantém acesso até <strong>{expiresAtBR}</strong>. Se mudar de ideia, é só reativar pela Kirvano."

**Observações:**
- Cancelamento NÃO bloqueia imediatamente — assinatura vira `status: CANCELED` mas `currentPeriodEnd` fica como estava.
- Pós-currentPeriodEnd, o grace period de 3 dias ainda aplica; depois marca `EXPIRED`.

---

## 4. Chargeback / Reembolso

**Subject:** `Zapfire — acesso suspenso`

**Variáveis:**
- `name`
- `kind` — `"REFUND"` ou `"CHARGEBACK"`

**Corpo (texto):**

```
Acesso suspenso por reembolso|chargeback. Se foi engano, responda este email.
```

**Corpo (HTML):**

1. Logo + "Acesso suspenso"
2. "Olá <strong>{name}</strong>, identificamos um <strong>reembolso|chargeback</strong> no seu pagamento, por isso sua chave foi bloqueada."
3. "Se foi engano, responda este email com o comprovante."

**Observações:**
- Bloqueia a chave (`AccessKey.status = BLOCKED`, `blockedReason = REFUND|CHARGEBACK`) e a subscription (`status: BLOCKED`).
- Email pedir resposta direta (sem link de autoatendimento) porque chargeback fraudulento precisa triagem manual.
- Triggered por `SALE_REFUNDED` (refund voluntário) ou `SALE_CHARGEBACK` (disputa bancária).

---

## 5. Magic link (login/reset)

**Subject:** `Zapfire — seu link de acesso`

**Variáveis:**
- `url` — `${PANEL_BASE_URL}/primeiro-acesso?token=${plaintext}` (expira em 7d)

**Corpo (texto):**

```
Acesse sua conta Zapfire: {url}
(link expira em 7 dias)
```

**Corpo (HTML):**

Estrutura mais enxuta que os outros (está inline em `account.js`, não usa o shell do kirvanoService):

1. `<h1>Seu link de acesso Zapfire</h1>`
2. "Clique no link abaixo pra acessar sua conta. Expira em 7 dias."
3. Botão vermelho "Acessar minha conta" → `url`
4. URL em texto (fallback pra clientes que não renderizam botões).

**Observações:**
- Endpoint `POST /api/v1/account/magic-link-request` retorna **sempre 200 com mesma mensagem**, mesmo se o email não existir (anti-enumeration). Ou seja: o atacante não consegue descobrir se um email é cliente só tentando pedir link.
- Rate limit: 5 req/min por IP.
- Consume marca `emailVerified: true`, `passwordSetAt: now()` no User.
- Gera também `RefreshToken` + `accessToken` de sessão (já loga o user direto após consumir).

---

## Como testar localmente

### Modo mock (sem configurar Resend)

Com `RESEND_API_KEY=""` no `.env` do backend, rode qualquer fluxo que dispara email. O log vai ter blocos tipo:

```
════════════════════════════════════════════════════════
[resend:mock] Email NÃO enviado (RESEND_API_KEY vazio)
   to     : joao@exemplo.com
   from   : Zapfire <contato@zapfire.com.br>
   subject: Bem-vindo ao Zapfire — configure sua senha
   text   : Bem-vindo ao Zapfire!...
   html   : <!DOCTYPE html><html>...
════════════════════════════════════════════════════════
```

Isso dá pra copiar o HTML e abrir no browser pra inspecionar visualmente, ou pegar o magic link direto do campo `text` pra consumir via curl.

### Modo real

1. Cria conta em [resend.com](https://resend.com)
2. Verifica o domínio `zapfire.com.br` na dashboard (registros DNS SPF + DKIM)
3. Gera API key e cola em `.env`:
   ```
   RESEND_API_KEY="re_xxxxxxxxxxxx"
   RESEND_FROM_EMAIL="Zapfire <contato@zapfire.com.br>"
   ```
4. Reinicia o backend
5. Qualquer webhook/magic link dispara envio real

### Teste rápido end-to-end

Dispara um `SALE_APPROVED` via curl (ver `docs/kirvano-webhook.md` seção "Testando localmente") → observa email. Em mock, copia o magic link do log e cola no browser → valida o fluxo do painel.

---

## Débito técnico e decisões futuras

- **Templates inline em JS:** OK pro MVP, ruim se um designer quiser mexer sem tocar em código. Se acontecer, migrar pra `eta` ou `handlebars` com arquivos `.hbs`/`.eta` em `backend/src/emails/`.
- **Imagens inline:** não usadas por ora (só texto + CSS). Logo Z é gerado com `<div>` + CSS. Se quiser logo real, hostear PNG em CDN pública e embutir `<img src="https://...">`.
- **Preview em Gmail/Outlook:** não testado em todos os clientes. A estrutura inline-style + tabela simples é o padrão seguro, mas vale smoke-testar com [mailtrap.io](https://mailtrap.io) ou [htmlemailcheck.com](https://htmlemailcheck.com) antes de ir pra produção em escala.
- **Bounces e spam:** Resend retorna status de entrega via webhook — não estamos consumindo. Sprint 6: hookar um endpoint `/webhooks/resend` pra marcar emails com `deliveryStatus` e reenviar magic link se bouncou.
- **i18n:** tudo em pt-BR hardcoded. Se virar produto global, extrair pra chaves de tradução.
- **Dark mode dos clientes:** Gmail/Apple Mail aplicam filtros automáticos em emails "muito escuros". Nossos emails podem ficar com contraste ruim em alguns clientes. Se virar queixa, testar com `color-scheme: light dark` meta tag ou simplesmente mudar pra paleta light com acento vermelho.
- **Preview text:** não configurado. Clientes de email mostram os primeiros chars do body como preview. Considerar adicionar `<div style="display:none">Texto de preview</div>` logo após `<body>` pra controlar essa prévia.
