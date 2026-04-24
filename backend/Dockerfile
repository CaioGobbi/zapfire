# ============================================================
# ZAPFIRE BACKEND — imagem Docker pra Railway
# ============================================================
# Node 20 slim com OpenSSL (required pelo query engine do Prisma).
#
# Build:
#   1. Instala dependências (npm ci — lê package-lock.json)
#   2. Gera Prisma client (pra ter node_modules/.prisma pronto)
#   3. Copia source
#
# Runtime:
#   1. npx prisma migrate deploy  (aplica migrations pendentes, idempotente)
#   2. node src/server.js         (sobe o Fastify)
# ============================================================

FROM node:20-slim

# OpenSSL é dep do Prisma query engine
RUN apt-get update -y \
    && apt-get install -y openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer de dependências — cacheia enquanto package-lock.json não mudar
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Prisma client precisa ser gerado pós-install
RUN npx prisma generate

# Copia o resto do código da aplicação
COPY src ./src

# Porta padrão. Railway injeta PORT em runtime; server.js lê process.env.PORT
EXPOSE 3000

# Aplica migrations pendentes e sobe o servidor
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
