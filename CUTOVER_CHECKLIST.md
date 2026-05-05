# Cutover Zapfire — Fase 2 (Railway → VPS)

**Status:** Fase 1 concluída em 04/05/2026. Aguardando cutover.

## Antes do cutover

- [ ] Forward email contato@zapfire.com.br → Gmail (Hostinger painel)
- [ ] Confirmar que VPS tá saudável (3 containers healthy)
- [ ] Backup do banco da VPS feito antes de mexer

## Cutover (estimado 30-40min)

### 1. SSL pros novos subdomínios

\`\`\`bash
ssh zapfire@2.24.71.239
sudo certbot --nginx \
  -d api.zapfire.com.br \
  -d app.zapfire.com.br \
  --email melfi@improvavel.com.br \
  --agree-tos --no-eff-email --redirect
\`\`\`

### 2. Criar vhosts api.zapfire.com.br e app.zapfire.com.br

Copiar config de api-novo e app-novo, substituindo o subdomínio.

### 3. Atualizar variáveis de ambiente

**Backend .env:**
- PANEL_BASE_URL=https://app.zapfire.com.br
- API_BASE_URL=https://api.zapfire.com.br

**Web .env:**
- NEXT_PUBLIC_API_URL=https://api.zapfire.com.br/api/v1

### 4. Rebuild do painel (NEXT_PUBLIC é build-time)

\`\`\`bash
export NEXT_PUBLIC_API_URL="https://api.zapfire.com.br/api/v1"
docker compose build web --no-cache
docker compose up -d --force-recreate backend web
\`\`\`

### 5. Trocar webhook URL na Kirvano

- Acessar painel Kirvano
- Integrações → Webhooks
- Editar URL: https://api.zapfire.com.br/webhooks/kirvano
- Confirmar token (KIRVANO_WEBHOOK_TOKEN do .env atual)

### 6. Smoke test completo

- [ ] curl https://api.zapfire.com.br/health → 200
- [ ] https://app.zapfire.com.br no browser → cadeado verde
- [ ] Login funcional no painel
- [ ] Webhook test da Kirvano (forçar venda de teste)
- [ ] Email recebido (magic link funcionando)
- [ ] Validate funcional (extensão batendo no novo backend)

## Pós-cutover (mantém Railway+Vercel 7 dias)

- [ ] Monitorar logs por 24h
- [ ] Confirmar nenhum erro crítico
- [ ] Cliente pagante testou? Validou OK?

## 7 dias depois (limpeza)

- [ ] Desligar Railway (pausar serviço)
- [ ] Desligar Vercel
- [ ] Atualizar CLAUDE.md com nova infra
- [ ] Cancelar billings antigos
- [ ] Remover subdomínios -novo (api-novo., app-novo.) do DNS

## Plano de rollback (se algo der errado)

1. **Reverter DNS:** apontar api. e app. de volta pra Railway/Vercel (procedimento conhecido)
2. **Reverter webhook Kirvano:** URL pra Railway antiga
3. **VPS continua de pé** pra investigar
4. Tempo total de rollback: ~5min se DNS já tava em cache antigo

## Débitos técnicos pós-cutover

- Forward email contato@ → Gmail
- Trocar deploy key VPS pra write access (ou só commitar do PC)
- Atualizar CLAUDE.md com toda infra nova
- Limpar regra ufw 443 pra 443/tcp (cosmético)
- Sprint 5 (Tracking + Daily Report)
- Submissão Chrome Web Store
