# Deploy do painel Zapfire na Vercel

> Guia do deploy inicial do painel (`/web`). Depois do primeiro deploy,
> pushes na `main` disparam redeploy automático.

## Pré-requisitos

- Conta na [Vercel](https://vercel.com)
- Backend já no ar na Railway (`ETAPA 2` deste sprint)
- URL pública do backend em mãos (ex: `https://zapfire-production.up.railway.app`)

## Arquitetura

```
Vercel Project "zapfire"
└── Deployment (GitHub → web/)
    ├── Framework: Next.js (auto-detectado)
    ├── Build:    next build
    ├── Output:   .next (server + static)
    └── Env:      NEXT_PUBLIC_API_URL → Railway backend
```

## Passo a passo

### 1. Importa o projeto

1. [vercel.com/new](https://vercel.com/new) → **Import Git Repository**
2. Autoriza GitHub se ainda não autorizou, e seleciona `CaioGobbi/zapfire`

### 2. Configura o projeto

Na tela de import:

- **Project Name**: `zapfire` (ou o nome que quiser — vai virar o slug do domínio `.vercel.app`)
- **Framework Preset**: `Next.js` (Vercel deve detectar automaticamente)
- **Root Directory**: `web` ← **essencial, senão o build falha** (click "Edit" se estiver vazio)
- **Build Command**: deixa o default (`next build`)
- **Output Directory**: deixa o default (`.next`)
- **Install Command**: deixa o default (`npm install`)

### 3. Environment Variables

Expande a seção **Environment Variables** na mesma tela de import:

| Nome | Valor |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://zapfire-production.up.railway.app/api/v1` (trocar pela URL real do seu Railway) |

Garante que o valor termina em `/api/v1` (sem barra no final). O resto do código depende desse formato.

### 4. Deploy

Clica **Deploy**. Vercel:
1. Clona o repo
2. Entra em `web/` (Root Directory)
3. Roda `npm install`
4. Roda `next build` (gera `.next/`)
5. Deploya o output

Tempo médio: ~1–2 minutos.

### 5. URL pública

Após deploy, Vercel atribui:
- `https://zapfire.vercel.app` (production alias)
- `https://zapfire-<git-branch>-<hash>.vercel.app` (deploy preview)

Anote o domínio production.

### 6. Atualiza CORS no backend

⚠️ **Importante**: agora que o painel tem URL real, o backend precisa aceitar requests dela.

1. Abre o Railway → service `zapfire` → **Variables**
2. Atualiza essas duas vars com a URL real:
   - `PANEL_BASE_URL` = `https://zapfire.vercel.app`
   - `PANEL_ORIGINS` = `https://zapfire.vercel.app`
3. Salva → Railway redeployz o backend automaticamente
4. Aguarda o healthcheck verde (~30s)

### 7. Valida end-to-end

1. Abre `https://zapfire.vercel.app` no browser
2. Deve redirecionar pra `/login`
3. Faz login com as credenciais do admin (seed):
   - Email: o `ADMIN_EMAIL` que você setou no Railway
   - Senha: o `ADMIN_PASSWORD` que você setou no Railway
4. Cai no `/dashboard`. No rodapé da sidebar deve aparecer **"Backoffice admin"**

## Preview deployments

A partir daqui, qualquer push em qualquer branch vira um preview deploy automático. PRs também. Cada um tem URL própria:

```
https://zapfire-git-<branch>-<team>.vercel.app
```

Isso é útil pra testar mudanças sem derrubar production. O production URL só atualiza em pushes na `main`.

## Pós-deploy

- **Logs**: Vercel dashboard → Deployments → click um deploy → aba "Runtime Logs"
- **Analytics**: disponível gratuitamente no plano Hobby (page views + Core Web Vitals)
- **Custom domain**: Settings → Domains → adicionar (quando tiver `zapfire.com.br`)

## Troubleshooting

### Build falha: "Module not found" ou tipo

Geralmente é Root Directory errado. Verifica que está `web` (não `web/`, não vazio).

### Build OK mas site não funciona / 500 em qualquer rota

Provavelmente a env var `NEXT_PUBLIC_API_URL` não foi setada. Verifica **Settings → Environment Variables**. Se mudou, precisa redeployar (pode fazer manualmente em **Deployments → ⋮ → Redeploy**).

### CORS error no browser

Backend não reconhece o origin do Vercel. Volta no passo 6 e confere `PANEL_ORIGINS` no Railway.

### Login falha com "Falha ao entrar — tente de novo"

É erro de fetch (CORS ou network). Abre DevTools → Network → aba "Fetch/XHR" → tenta logar → confere se a request chegou com status 200.

### Login falha com "Email ou senha incorretos"

A seed não rodou no backend. Roda:
```bash
railway run --service zapfire npm run db:seed
```

### Cookie `zf_refresh` não persiste

O cookie precisa de `Secure: true` em produção (HTTPS). Nosso backend seta isso automaticamente quando `NODE_ENV=production`. Confere no Railway que `NODE_ENV` está setada certo.

## Custos

Vercel Hobby é grátis pra projetos pessoais/internos:
- Builds: 6.000 minutos/mês (suficiente pra dezenas de deploys por dia)
- Bandwidth: 100 GB/mês
- Serverless functions: 100 GB-Hours

Nosso painel é estático-like + API calls pro backend (que não é contado como function). Não tem risco de sair do free tier no início.

## Próximos passos

- ETAPA 4: validar fluxo end-to-end (painel ↔ backend ↔ extensão)
- ETAPA 5: rebuild da extensão com URLs reais → Chrome Web Store prep
