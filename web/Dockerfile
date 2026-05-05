# ============================================================
# ZAPFIRE PAINEL WEB — Next.js 14 standalone
# ============================================================
# Multi-stage build:
#   1. deps     — instala node_modules
#   2. builder  — roda next build (gera .next/standalone)
#   3. runner   — runtime mínimo (só Node + standalone build)
#
# Resultado: imagem ~150MB (vs 1GB+ se fizesse single-stage)
# ============================================================

# ===== STAGE 1: deps =====
FROM node:20-alpine AS deps

# libc6-compat necessário pra alguns pacotes Next no Alpine
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copia só os arquivos de dependências pra otimizar cache
COPY package.json package-lock.json* ./

# npm ci é mais rápido e determinístico que npm install
RUN npm ci

# ===== STAGE 2: builder =====
FROM node:20-alpine AS builder

WORKDIR /app

# Reaproveita node_modules do stage anterior
COPY --from=deps /app/node_modules ./node_modules

# Copia todo o código fonte
COPY . .

# Variáveis NEXT_PUBLIC_* precisam estar disponíveis durante o build
# Elas são "congeladas" no bundle JS que vai pro browser
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Build do Next — gera .next/standalone
RUN npm run build

# ===== STAGE 3: runner =====
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

# Cria usuário não-root pra rodar o app
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copia apenas o que precisa rodar
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3001

# Server.js é gerado pelo standalone build
CMD ["node", "server.js"]
