# Webhook Kirvano — integração Zapfire

> **Status**: validado contra payloads reais da Kirvano em prod (2026-04-26). Schema base no `backend/src/routes/webhooks.js` aceita os 8 eventos documentados (BANK_SLIP_*, PIX_*, SALE_APPROVED/REFUSED/CHARGEBACK). Campos `event`, `sale_id`, `customer.email` e `total_price` são considerados obrigatórios; o resto é tolerante via `.passthrough()`.

- **Doc oficial**: https://help.kirvano.com/hc/central-de-ajuda/articles/1765385505-configurando-integracao-via-webhook
- **Endpoint nosso**: `POST /api/v1/webhooks/kirvano`
- **Autenticação**: header **`security-token`** igual à variável `KIRVANO_WEBHOOK_TOKEN` do backend. Token errado/ausente → `401`. Qualquer outro erro → `200` (pra Kirvano não entrar em retry loop).
  - ⚠ A doc da Kirvano **não revela** o nome do header — descoberto empiricamente. Original: assumimos `X-Kirvano-Token` (errado).
  - ⚠ O botão **"Testar Integração"** do painel Kirvano **NÃO inclui o token** na request — só serve pra checar conectividade. Pra testar a auth de verdade, faz uma compra real (cupom 100% off ou oferta R$1).
- **Idempotência**: por `kirvanoSaleId` (campo `sale_id` do payload). Se já existe um `Payment` com esse saleId, o evento é ignorado e respondemos 200.
- **Rate limit**: 120 req/min por IP.

## Padronização de campos

A Kirvano mistura `snake_case` e `camelCase` no mesmo payload sem critério aparente:

- snake: `sale_id`, `payment_method`, `total_price`, `event_description`, `is_order_bump`, `offer_id`, `created_at`, `phone_number`
- camel: `contactEmail`, `couponDiscount`, `automaticDiscount`, `affiliateCommission`, `coproductionCommission`

Não impacta nada (Zod `.passthrough()` aceita), mas vale saber.

## Offer IDs em produção

Os IDs reais estão em [`backend/src/lib/kirvanoParser.js`](../backend/src/lib/kirvanoParser.js):

| Plano | offer_id (Kirvano) | Plan code interno |
|---|---|---|
| Plano Mensal - ZapFire (R$47) | `10eb5393-19a0-4894-ab70-292b49b5c84c` | `monthly_v1` |
| Plano Anual - ZapFire (R$395) | `7b80209b-9bb7-43f1-95a0-346a6fe35fd5` | `annual_v1` |

Quando criar nova oferta (promoção, A/B test, etc), adicionar o offer_id na Set correspondente em `kirvanoParser.js` e fazer redeploy. Caso contrário cai no fallback por `charge_frequency` (ANNUALLY → annual_v1; resto → monthly_v1) — funciona pra recorrente padrão mas é menos preciso pra one-time.

## Tabela de eventos

| Evento Kirvano            | Ação Zapfire                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SALE_APPROVED`           | Upsert User · cria Subscription ACTIVE · gera AccessKey nova · cria Payment PAID · gera EmailToken MAGIC_LINK (7d) · envia email de boas-vindas · audit log         |
| `SUBSCRIPTION_RENEWED`    | Acha Subscription por `kirvanoSaleId` (ou `subscription.id` → `gatewaySubId`) · atualiza `currentPeriodEnd` · limpa `gracePeriodEndsAt` · cria Payment · email confirma |
| `SUBSCRIPTION_CANCELED`   | Marca Subscription `CANCELED` + `canceledAt` + `cancelReason` · **NÃO bloqueia** acesso (mantém até `currentPeriodEnd`) · email informa                              |
| `SUBSCRIPTION_EXPIRED`    | Marca Subscription `EXPIRED`                                                                                                                                       |
| `SALE_REFUNDED`           | Marca Payment `REFUNDED` · bloqueia AccessKey (`status: BLOCKED`, `blockedReason: "REFUND"`) · email informa                                                         |
| `SALE_CHARGEBACK`         | Marca Payment `CHARGEBACK` · bloqueia AccessKey (`status: BLOCKED`, `blockedReason: "CHARGEBACK"`) · email informa                                                 |
| `PIX_GENERATED`           | Apenas log (sem ação)                                                                                                                                              |
| `PIX_EXPIRED`             | Apenas log (sem ação)                                                                                                                                              |
| (qualquer outro)          | Log + 200 OK                                                                                                                                                       |

## Schema (Zod)

Todos os eventos compartilham essa estrutura base. Campos específicos dependem do evento:

```js
{
  event:       "SALE_APPROVED" | "SUBSCRIPTION_RENEWED" | ...,
  sale_id:     "uuid-string",              // OBRIGATÓRIO, chave de idempotência
  status?:     "APPROVED" | "CANCELED" | ...,
  type?:       "ONE_TIME" | "RECURRING",
  created_at?: "2023-12-18 16:40:06",      // São Paulo UTC-3
  finished_at?:"2023-12-18 16:40:06",

  customer: {
    email:         "cliente@exemplo.com",  // OBRIGATÓRIO
    name?:         "Fulano da Silva",
    phone_number?: "+5511999999999",
    document?:     "12345678909"
  },

  products?: [{
    id?:       "prod-xxx",
    offer_id?: "offer-xxx",                // usado pra detectar mensal vs anual
    name?:     "Plano Anual",
    price?:    "R$ 395,00"
  }],

  plan?: {
    id?:               "plan-xxx",
    name?:             "Anual",
    charge_frequency?: "MONTHLY" | "ANNUALLY" | "ONE_TIME",
    next_charge_date?: "2024-12-18"         // só nos recorrentes
  },

  subscription?: {
    id:      "sub-xxx",
    status?: "ACTIVE" | "CANCELED" | ...
  },

  payment?: {
    method?:       "CREDIT_CARD" | "PIX" | "BOLETO",
    total_amount?: "R$ 47,00"
  },

  total_price?: "R$ 47,00"                  // fallback se payment.total_amount ausente
}
```

## Payloads de exemplo

### `SALE_APPROVED` (primeira compra mensal)

```json
{
  "event": "SALE_APPROVED",
  "sale_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "APPROVED",
  "type": "RECURRING",
  "created_at": "2026-04-24 10:00:00",
  "finished_at": "2026-04-24 10:00:05",
  "customer": {
    "email": "joao@exemplo.com",
    "name": "João da Silva",
    "phone_number": "+5511987654321",
    "document": "12345678909"
  },
  "products": [
    { "id": "prod-monthly", "offer_id": "off-monthly-v1", "name": "Mensal", "price": "R$ 47,00" }
  ],
  "plan": {
    "id": "plan-monthly-v1",
    "name": "Mensal",
    "charge_frequency": "MONTHLY",
    "next_charge_date": "2026-05-24"
  },
  "subscription": { "id": "sub-xyz", "status": "ACTIVE" },
  "payment": { "method": "CREDIT_CARD", "total_amount": "R$ 47,00" },
  "total_price": "R$ 47,00"
}
```

### `SUBSCRIPTION_RENEWED` (renovação mensal)

```json
{
  "event": "SUBSCRIPTION_RENEWED",
  "sale_id": "renewal-sale-id-0002",
  "status": "APPROVED",
  "created_at": "2026-05-24 10:00:00",
  "customer": { "email": "joao@exemplo.com" },
  "plan": { "charge_frequency": "MONTHLY", "next_charge_date": "2026-06-24" },
  "subscription": { "id": "sub-xyz", "status": "ACTIVE" },
  "payment": { "method": "CREDIT_CARD", "total_amount": "R$ 47,00" },
  "total_price": "R$ 47,00"
}
```

### `SALE_REFUNDED`

```json
{
  "event": "SALE_REFUNDED",
  "sale_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "REFUNDED",
  "created_at": "2026-04-26 09:00:00",
  "customer": { "email": "joao@exemplo.com" },
  "subscription": { "id": "sub-xyz" },
  "total_price": "R$ 47,00"
}
```

## Testando localmente

### 1. Setup

No `.env` do backend:

```bash
KIRVANO_WEBHOOK_TOKEN="dev-local-token-$(openssl rand -hex 16)"
```

### 2. Com curl

```bash
TOKEN="seu-token-do-env"
curl -X POST http://localhost:3000/api/v1/webhooks/kirvano \
  -H "Content-Type: application/json" \
  -H "X-Kirvano-Token: $TOKEN" \
  -d '{
    "event": "SALE_APPROVED",
    "sale_id": "test-'"$(date +%s)"'",
    "customer": {
      "email": "teste-manual@zapfire.com.br",
      "name": "Teste Manual"
    },
    "plan": { "charge_frequency": "MONTHLY" },
    "total_price": "R$ 47,00"
  }'
```

Esperado: `200 OK` + `{"ok":true,"processed":"SALE_APPROVED"}`. O log do backend mostra o email no modo mock (a chave e o link do painel), pronto pra você colar na extensão.

### 3. Expondo com ngrok (pra Kirvano enviar de verdade)

```bash
ngrok http 3000
# pega a URL https://xxxx.ngrok-free.app
# cadastra na Kirvano: https://xxxx.ngrok-free.app/api/v1/webhooks/kirvano
# cadastra o X-Kirvano-Token no painel da Kirvano
```

### 4. Re-envio e idempotência

Rode o mesmo curl 2x com o mesmo `sale_id`. A segunda resposta deve ser `{"ok":true,"skipped":"already_processed"}` sem criar chave/usuário novos.

## Segurança

- **Nunca** confiar no body sem checar `X-Kirvano-Token` antes.
- **Nunca** logar o token em `validation_logs` ou `audit_logs`.
- O payload cru é salvo em `Payment.rawWebhookPayload` pra debug; cuidado se for exportar dump do banco (pode conter email/CPF do cliente).
- Respondemos sempre 200 após validar o token, mesmo em erros de processamento interno, pra Kirvano não entrar em loop de retry. Os erros ficam em `audit_logs` com `action: "webhook.error"`.
