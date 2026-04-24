# Deploy do backend Zapfire na Railway

> Guia do deploy inicial do backend. Depois do primeiro deploy,
> pushes na branch `main` disparam redeploy automático.

## Pré-requisitos

- Conta na [Railway](https://railway.app)
- Repositório `zapfire` conectado ao GitHub
- Variáveis de produção prontas (especialmente `JWT_SECRET` e `KIRVANO_WEBHOOK_TOKEN`)

## Arquitetura do deploy

```
Railway Project "zapfire"
├── Service: Postgres (managed)
│   └── Env injetado automaticamente no backend: DATABASE_URL
└── Service: zapfire-backend (GitHub → backend/)
    ├── Builder: Dockerfile (backend/Dockerfile — Node 20 slim + OpenSSL)
    ├── CMD: sh -c "npx prisma migrate deploy && node src/server.js"
    └── Healthcheck: GET /health
```

> **Por que Dockerfile e não Nixpacks/Railpack?** Railway migrou pra Railpack
> recentemente e o auto-detect às vezes falha em monorepos. Dockerfile é
> determinístico — a gente controla exatamente o ambiente (Node version,
> OpenSSL, comando de start).

## Passo a passo

### 1. Cria o projeto

1. Entra em [railway.app/new](https://railway.app/new) → **Deploy from GitHub repo**
2. Seleciona `CaioGobbi/zapfire`
3. Railway vai detectar que é um monorepo e perguntar qual serviço criar. **NÃO** deixa ele criar um único serviço — vamos configurar manualmente.

### 2. Adiciona o Postgres

1. No projeto, clica **+ New** → **Database** → **Add PostgreSQL**
2. Railway provisiona o banco. Automaticamente expõe as vars:
   - `DATABASE_URL`
   - `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (úteis se precisar conectar externamente)

### 3. Cria o serviço do backend

1. **+ New** → **GitHub Repo** → `zapfire`
2. Nome do serviço: `zapfire-backend`
3. **Settings** do serviço:
   - **Root Directory**: `backend` ← **essencial, senão o build falha**
   - **Watch Paths**: `backend/**` (redeploy só quando mexer em `backend/`)
   - Railway lê o `railway.json` dentro de `backend/` automaticamente, que aponta pro `Dockerfile`

### 4. Conecta o backend ao Postgres

1. No serviço `zapfire-backend`, aba **Variables**
2. **Add Reference** → seleciona o Postgres → escolhe `DATABASE_URL`
3. O valor fica igual a `${{Postgres.DATABASE_URL}}` — Railway resolve no boot

### 5. Adiciona as variáveis de ambiente restantes

Na aba **Variables** do `zapfire-backend`:

| Var | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `JWT_SECRET` | gerar com `openssl rand -hex 32` (NÃO reusar o de dev) |
| `KIRVANO_WEBHOOK_TOKEN` | gerar novo token, atualizar tb no painel da Kirvano |
| `RESEND_API_KEY` | criar em [resend.com](https://resend.com) quando for usar email real; deixar vazio em primeiro deploy pra mock mode |
| `RESEND_FROM_EMAIL` | `"Zapfire <contato@zapfire.com.br>"` (ou outro domínio verificado) |
| `RESEND_WEBHOOK_TOKEN` | gerar token, cadastrar em resend.com webhooks depois |
| `PANEL_BASE_URL` | URL final do painel na Vercel (por enquanto placeholder tipo `https://zapfire.vercel.app`) |
| `PANEL_ORIGINS` | Mesmo valor do `PANEL_BASE_URL` (separar por vírgula se tiver múltiplos) |
| `ADMIN_EMAIL` | seu email admin |
| `ADMIN_PASSWORD` | senha admin (seed usa isso na 1ª execução) |
| `LOG_LEVEL` | `info` (ou `warn` pra menos ruído) |

**NÃO** precisa setar `PORT` — Railway injeta sozinho.

**NÃO** precisa setar `DATABASE_URL` — veio via reference.

### 6. Primeiro deploy

1. Clica **Deploy** (ou aguarda push na main)
2. Aba **Deploy Logs**:
   - Build: Nixpacks instala deps, roda `prisma generate`
   - Deploy: roda `prisma migrate deploy` (aplica migrations no DB novo), depois `node src/server.js`
   - Logs do Fastify: `Zapfire backend rodando em http://0.0.0.0:PORT`
3. Aba **Settings** → **Networking** → **Generate Domain**
   - Railway gera algo tipo `zapfire-backend-production-xxxx.up.railway.app`
4. **Healthcheck** automático: Railway bate `/health` — se retornar 200 (que é o caso), o serviço fica "Active" 🟢

### 7. Valida com curl

```bash
BASE="https://zapfire-backend-production-xxxx.up.railway.app"

# Healthcheck
curl $BASE/health
# Esperado: {"ok":true,"service":"zapfire-backend","time":"..."}

# CORS headers
curl -I -H "Origin: https://zapfire.vercel.app" $BASE/health
# Deve vir com Access-Control-Allow-Origin na resposta

# Webhook auth
curl -X POST $BASE/api/v1/webhooks/kirvano \
  -H "Content-Type: application/json" \
  -d '{"event":"ALIEN","sale_id":"x","customer":{"email":"a@b.co"}}'
# Esperado: HTTP 401 (sem token)
```

### 8. Rode a seed (ONE-TIME)

Após o primeiro deploy, o banco tá vazio (só migrations aplicadas, sem dados).

Opção A — pelo Railway CLI (recomendado):

```bash
npm i -g @railway/cli
railway login
railway link             # seleciona o projeto zapfire
railway run --service zapfire-backend npm run db:seed
# Cria admin + planos + chave de teste. Anote a chave.
```

Opção B — via script remoto (se a gente precisar reseedar):
- Adicionar endpoint admin one-shot, proteger por secret header. Futuro — evitar.

### 9. Cadastra URL do webhook Kirvano

No painel da Kirvano, cadastra o webhook URL:

```
https://zapfire-backend-production-xxxx.up.railway.app/api/v1/webhooks/kirvano
```

E cadastra o header custom `X-Kirvano-Token` com o valor de `KIRVANO_WEBHOOK_TOKEN` que você definiu no Railway.

### 10. Cadastra URL do webhook Resend (quando for usar email real)

Painel Resend → Webhooks → Add Endpoint:

```
URL: https://zapfire-backend-production-xxxx.up.railway.app/api/v1/webhooks/resend
Eventos: email.delivered, email.bounced, email.complained, email.failed
Custom header: X-Zapfire-Resend-Token = <RESEND_WEBHOOK_TOKEN>
```

## Pós-deploy

- **Logs ao vivo**: `railway logs --service zapfire-backend` (ou via UI)
- **Shell remoto** (debug): `railway run --service zapfire-backend bash`
- **Redeploy manual**: aba **Deployments** → `Redeploy`
- **Rollback**: aba **Deployments** → clicar num deploy antigo → `Redeploy this version`
- **DB GUI**: Railway oferece **Data** tab no serviço Postgres, ou usar Prisma Studio local com `DATABASE_URL` exportado

## Troubleshooting

### Build falha — "P1001: Can't reach database"

Prisma rodou antes do Postgres estar pronto. Dá Retry no deploy. Se persistir, verifica se `DATABASE_URL` está setada via reference.

### Start falha — "migration drift"

Alguém mexeu no schema do DB manualmente. Opções:
- `prisma migrate resolve --applied <nome>` pra marcar migrations como aplicadas
- No pior caso, `prisma migrate reset` (destrói dados — só aceitável em stage)

### 502 Bad Gateway no domínio

Healthcheck falhando. Verifica:
- Logs do deploy (crash loop?)
- Se `HOST=0.0.0.0` (não `localhost`)
- Se `PORT` está sendo lido (nosso server.js lê `process.env.PORT`)

### CORS bloqueia painel

Confere `PANEL_ORIGINS` — tem que bater exatamente com o origin do Vercel (com `https://`, sem barra final).

### Migrations aplicadas mas tabela não existe

Deploy rodou antes da última migration ser committada. Push novo commit e redeploy.

## Custos estimados (como referência)

Railway free tier: $5/mês de crédito grátis. O backend + Postgres deve ficar em ~$5–15/mês dependendo de tráfego. Upgrade pra Hobby ($5 flat + usage) quando passar do free.

## Próximos passos

- ETAPA 3: deploy do painel (`/web`) na Vercel, atualizar `PANEL_BASE_URL` e `PANEL_ORIGINS` no Railway
- ETAPA 4: integração end-to-end, atualizar manifest.json via build da extensão
- ETAPA 5: Chrome Web Store
