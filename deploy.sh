#!/bin/bash
# ============================================================
# DEPLOY ZAPFIRE — VPS Hostinger Boston
# ============================================================
# Uso:
#   ./deploy.sh backend         → deploy só do backend
#   ./deploy.sh web             → deploy só do painel
#   ./deploy.sh web --no-cache  → deploy painel com rebuild full
#   ./deploy.sh all             → deploy backend + web
#   ./deploy.sh status          → ver estado dos containers
#   ./deploy.sh logs backend    → últimos 50 logs do backend
#   ./deploy.sh logs web        → últimos 50 logs do web
# ============================================================

set -e  # Para em qualquer erro

# Configuração
VPS_USER="zapfire"
VPS_HOST="2.24.71.239"
VPS_PROJECT_DIR="/home/zapfire/zapfire"
VPS_REPO_DIR="/home/zapfire/zapfire/repo"

# Cores pro output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Funções de log
info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
ok()      { echo -e "${GREEN}✅ $1${NC}"; }
warn()    { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()     { echo -e "${RED}❌ $1${NC}"; exit 1; }

# Helper: rodar comando na VPS
remote() {
    ssh "$VPS_USER@$VPS_HOST" "$@"
}

# Modos de deploy
deploy_backend() {
    info "Deploy do BACKEND iniciado"
    
    info "Pulling código novo do GitHub..."
    remote "cd $VPS_REPO_DIR && git pull origin main"
    
    info "Buildando imagem do backend..."
    remote "cd $VPS_PROJECT_DIR && docker compose build backend"
    
    info "Recriando container backend..."
    remote "cd $VPS_PROJECT_DIR && docker compose up -d --force-recreate backend"
    
    info "Aguardando healthcheck (60s)..."
    sleep 60
    
    info "Estado dos containers:"
    remote "cd $VPS_PROJECT_DIR && docker compose ps"
    
    info "Smoke test no /health..."
    if curl -sf https://api.zapfire.com.br/health > /dev/null; then
        ok "Backend respondendo via api.zapfire.com.br"
    else
        err "Backend não está respondendo!"
    fi
    
    ok "Deploy do backend completo"
}

deploy_web() {
    local extra_flags="$1"
    info "Deploy do WEB iniciado"
    
    if [ "$extra_flags" = "--no-cache" ]; then
        warn "Modo --no-cache ativado: build vai demorar 5-10min"
    fi
    
    info "Pulling código novo do GitHub..."
    remote "cd $VPS_REPO_DIR && git pull origin main"
    
    info "Buildando imagem do web..."
    if [ "$extra_flags" = "--no-cache" ]; then
        remote "cd $VPS_PROJECT_DIR && export NEXT_PUBLIC_API_URL='https://api.zapfire.com.br/api/v1' && docker compose build web --no-cache"
    else
        remote "cd $VPS_PROJECT_DIR && export NEXT_PUBLIC_API_URL='https://api.zapfire.com.br/api/v1' && docker compose build web"
    fi
    
    info "Recriando container web..."
    remote "cd $VPS_PROJECT_DIR && docker compose up -d --force-recreate web"
    
    info "Aguardando healthcheck (60s)..."
    sleep 60
    
    info "Estado dos containers:"
    remote "cd $VPS_PROJECT_DIR && docker compose ps"
    
    info "Smoke test no painel..."
    HTTP_CODE=$(curl -sIo /dev/null -w "%{http_code}" https://app.zapfire.com.br/)
    if [ "$HTTP_CODE" = "200" ]; then
        ok "Painel respondendo via app.zapfire.com.br ($HTTP_CODE)"
    else
        err "Painel retornou $HTTP_CODE!"
    fi
    
    ok "Deploy do web completo"
}

deploy_all() {
    deploy_backend
    deploy_web "$1"
    ok "Deploy completo: backend + web"
}

show_status() {
    info "Estado atual dos containers na VPS:"
    remote "cd $VPS_PROJECT_DIR && docker compose ps"
    
    echo ""
    info "Smoke tests:"
    
    if curl -sf https://api.zapfire.com.br/health > /dev/null; then
        ok "API respondendo: https://api.zapfire.com.br/health"
    else
        warn "API não responde"
    fi
    
    HTTP_CODE=$(curl -sIo /dev/null -w "%{http_code}" https://app.zapfire.com.br/)
    if [ "$HTTP_CODE" = "200" ]; then
        ok "Painel respondendo: https://app.zapfire.com.br ($HTTP_CODE)"
    else
        warn "Painel retornou $HTTP_CODE"
    fi
}

show_logs() {
    local service="$1"
    if [ -z "$service" ]; then
        err "Uso: ./deploy.sh logs <backend|web|postgres>"
    fi
    
    info "Últimos 50 logs do $service:"
    remote "cd $VPS_PROJECT_DIR && docker compose logs $service --tail 50"
}

# Main: parse argumentos
case "$1" in
    backend)
        deploy_backend
        ;;
    web)
        deploy_web "$2"
        ;;
    all)
        deploy_all "$2"
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs "$2"
        ;;
    *)
        echo "Uso: $0 <comando> [opções]"
        echo ""
        echo "Comandos:"
        echo "  backend                Deploy só do backend (~1min)"
        echo "  web                    Deploy só do painel (~3-5min)"
        echo "  web --no-cache         Deploy painel com rebuild full (~10min)"
        echo "  all                    Deploy backend + web"
        echo "  status                 Ver estado dos containers"
        echo "  logs <serviço>         Ver últimos 50 logs"
        echo ""
        echo "Exemplos:"
        echo "  $0 backend             # mudou só código do backend"
        echo "  $0 web                 # mudou só código do painel"
        echo "  $0 web --no-cache      # mudou .env do painel"
        echo "  $0 status              # ver tudo verde?"
        echo "  $0 logs backend        # debug rápido"
        exit 1
        ;;
esac
