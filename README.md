# 🔥 Zapfire

Extensão Chrome + backend de licenciamento para automação de WhatsApp Web, focada em afiliados X1.

Arquitetura inspirada no ZapVoice, adaptada pro ecossistema IMP/MétriqAI.

## Arquitetura

```
┌─────────────────────┐         ┌─────────────────────┐
│ Extensão Chrome     │         │ Backend Node.js     │
│                     │         │                     │
│  ┌──────────────┐   │  HTTPS  │  ┌──────────────┐   │
│  │ Popup        │ ────────────→ │ Fastify API  │   │
│  └──────────────┘   │         │  └──────┬───────┘   │
│  ┌──────────────┐   │         │         │           │
│  │ Service      │   │         │  ┌──────▼───────┐   │
│  │ Worker (bg)  │───┼─────────┼─→│ Prisma ORM   │   │
│  └──────────────┘   │         │  └──────┬───────┘   │
│  ┌──────────────┐   │         │         │           │
│  │ Content      │   │         │  ┌──────▼───────┐   │
│  │ Script       │   │         │  │ PostgreSQL   │   │
│  │ (web.wa.com) │   │         │  └──────────────┘   │
│  └──────────────┘   │         │                     │
└─────────────────────┘         └─────────────────────┘
```

**Fluxo de auth:**
1. Cliente paga → webhook gera chave UUID no banco
2. Cliente cola chave no popup da extensão
3. Extensão lê número do WhatsApp Web via IndexedDB
4. Backend valida e faz bind (chave ↔ número) no primeiro uso
5. Toda revalidação compara número atual com número vinculado

## Estrutura

```
zapfire/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       # modelo do banco
│   │   └── seed.js             # dados iniciais
│   ├── src/
│   │   ├── server.js           # entrypoint Fastify
│   │   ├── lib/prisma.js       # singleton do Prisma
│   │   ├── routes/auth.js      # endpoints /auth/validate, /auth/heartbeat
│   │   └── services/
│   │       └── keyService.js   # lógica de bind e validação
│   ├── .env.example
│   └── package.json
├── extension/
│   ├── manifest.json           # Manifest V3
│   ├── background/
│   │   └── service-worker.js   # gerencia auth e heartbeat
│   ├── content/
│   │   └── content.js          # injetado no web.whatsapp.com
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.js
│   └── assets/                 # ícones 16/48/128
└── docs/
```

## Setup (desenvolvimento)

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edite o .env e aponte DATABASE_URL pro seu Postgres local

npm install
npm run db:push           # cria as tabelas
npm run db:seed           # popula com chave de teste (imprime a chave no console)
npm run dev               # roda em http://localhost:3000
```

Você vai ver no console algo como:

```
═══════════════════════════════════════════════════════
🔑 CHAVE DE TESTE GERADA:
    3b36c0db084640b688a4c4e58d9c7f96
    (cole essa chave no popup da extensão)
═══════════════════════════════════════════════════════
```

Copia essa chave.

### 2. Extensão

Antes de carregar, troque a URL da API no service worker pra apontar pro localhost:

Em `extension/background/service-worker.js`, linha 10:
```js
const API_BASE = 'http://localhost:3000/api/v1';
```

E em `extension/manifest.json`, adicione no `host_permissions`:
```json
"host_permissions": [
  "https://web.whatsapp.com/*",
  "http://localhost:3000/*"
]
```

Então:
1. Abra `chrome://extensions`
2. Ative "Modo do desenvolvedor" (canto superior direito)
3. Clique em "Carregar sem compactação"
4. Selecione a pasta `extension/`
5. Abra `https://web.whatsapp.com` e faça login com seu celular
6. Clique no ícone da extensão
7. Cole a chave que o seed imprimiu

Se tudo deu certo, você vai ver a tela autenticada com:
- Conta: Caio Gobbi (Teste)
- Número: seu número do WhatsApp mascarado
- Plano: Mensal X1
- Vence em: daqui a 1 ano

## Próximos sprints

- [ ] Sprint 2: painel web do assinante (Next.js reaproveitando stack MétriqAI)
- [ ] Sprint 3: envio de áudio "ao vivo" no WhatsApp Web (content script)
- [ ] Sprint 4: funis com delays + gatilhos por palavra-chave
- [ ] Sprint 5: webhook Pagar.me integrado
- [ ] Sprint 6: backoffice admin
- [ ] Sprint 7: ofuscação + publicação na Chrome Web Store

## Notas de segurança

- Extensão Chrome é JS em texto claro — toda validação CRÍTICA roda no backend
- Rate limit de 30 req/min por IP no `/auth/validate`
- Todo attempt é logado em `validation_logs` pra detectar pirataria
- Chave é um UUID v4 (32 chars hex, 128 bits de entropia — brute force inviável)
- Em produção, ative HTTPS obrigatório e HSTS
