# Submission do Zapfire na Chrome Web Store

> Guia completo pra publicar a extensão. Inclui textos prontos pra copiar,
> checklist de assets e explicação de cada permissão (o review rejeita se
> alguma ficar sem justificativa).

## Pré-requisitos

- **Conta de desenvolvedor**: $5 USD, uma vez na vida. Registra em
  [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole/)
- **Zip da extensão**: gerado por `npm run build` em `/extension`. Arquivo
  fica em `extension/dist/zapfire-extension-<version>.zip`.
- **URL da política de privacidade**: já publicada em
  `https://zapfire-five.vercel.app/privacy` (depois de fazer deploy dessa
  versão do painel). Obrigatório no formulário.

## Build final de produção

```bash
cd extension
ZF_API_BASE="https://zapfire-production.up.railway.app/api/v1" \
ZF_PANEL_URL="https://zapfire-five.vercel.app" \
node build.mjs
```

Arquivo a fazer upload: `extension/dist/zapfire-extension-0.1.0.zip` (415 KB).

## Store Listing — textos prontos

### Nome do produto
> Zapfire — WhatsApp Web turbo pra afiliados

(máx 45 chars — o atual está OK)

### Descrição curta (summary) — máx 132 chars
> Turbine seu WhatsApp Web: envie áudios pré-gravados, scripts e funis de atendimento com 1 clique.

### Descrição longa (description) — pronta pra colar

```
O Zapfire adiciona recursos de produtividade ao WhatsApp Web pra quem
atende clientes 1-a-1 e precisa escalar sem perder qualidade.

✨ O QUE ELE FAZ
- 📨 Envio rápido de scripts (mensagens prontas) com 1 clique
- 🎙️ Biblioteca de áudios pré-gravados — envie como se estivesse gravando na hora, com waveform real
- 🖼️ Mídias (imagem, vídeo, arquivo) salvas e prontas pra disparar
- 🔁 Funis automatizados — sequência de mensagens + delays, dispara com 1 clique
- ⚡ Múltiplas conversas ao mesmo tempo: os funis rodam em paralelo
- 🎨 QuickBar abaixo do input pra disparo rápido sem abrir menus

💼 PRA QUEM É
- Afiliados que fecham venda pelo WhatsApp
- Closers de infoprodutos
- Times de atendimento que precisam de scripts consistentes
- SDRs que qualificam via mensagem

🔒 PRIVACIDADE
- Seus scripts, áudios e mídias ficam exclusivamente no seu navegador
  (IndexedDB local). Nossos servidores nunca tocam nesse conteúdo.
- Apenas dados de licenciamento (email, chave, número do WhatsApp pra
  bind anti-pirataria) são armazenados remotamente.
- Veja detalhes em: https://zapfire-five.vercel.app/privacy

🛠 COMO FUNCIONA
1. Adquira sua chave em zapfire.com.br
2. Instale a extensão
3. Cole a chave no popup → a extensão valida e vincula ao seu WhatsApp
4. Abra o web.whatsapp.com — a sidebar e quickbar aparecem automaticamente
5. Clique nos items pra enviar, ou monte funis no gerenciador

❓ SUPORTE
contato@zapfire.com.br
```

### Categoria
- **Principal**: Productivity
- **Tags/labels sugeridas**: WhatsApp, Produtividade, Vendas, Afiliados, CRM

### Idioma
- Default language: **Portuguese (Brazil)** — `pt-BR`

## Assets gráficos obrigatórios

| Asset | Tamanho | Status |
|---|---|---|
| Ícone da extensão | 128x128 PNG | ✅ `extension/assets/icon-128.png` |
| Screenshot 1 | 1280x800 ou 640x400 | ❌ Falta — ver dicas abaixo |
| Screenshot 2–5 | 1280x800 ou 640x400 | 🟡 Opcional mas recomendado |
| Small promo tile | 440x280 PNG | ❌ Falta — design necessário |
| Marquee promo tile | 1400x560 PNG | 🟡 Opcional (só pra Featured) |

### Dicas pra os screenshots

Cada um precisa ser PNG ou JPG com o tamanho exato. Sugestões do que capturar:

1. **Popup ativo** (1280x800 ou 640x400): popup da extensão mostrando a chave ativa, conta, plano, vencimento. Mostra status de saúde da assinatura.

2. **Sidebar aberta no WA Web** (1280x800): WA Web no fundo com a sidebar Zapfire aberta à direita, tab "Funis" ou "Mensagens" com alguns cards. Realça o valor visual do produto.

3. **Quickbar em ação** (1280x800 ou 640x400): close-up do footer do WA com a quickbar visível — chips coloridos por tipo (funil vermelho, mensagem azul, áudio roxo, mídia laranja). Vende o "1 clique".

4. **Gerenciador** (1280x800): tela cheia do manager com a aba "Tudo" exibindo os 5 stat cards, ou a aba "Funis" com o editor de funil aberto. Mostra o lado B2B / profissional.

5. **Painel do assinante** (1280x800): dashboard com chave ativa, plano, número vinculado. Mostra que é um produto "completo" e não só uma extensão standalone.

Ferramentas que podem ajudar:
- [Screenshot do Chrome dev tools](https://developer.chrome.com/docs/devtools/device-mode/) com tamanho exato
- [Figma](https://figma.com) pra montar as imagens promocionais (440x280, 1400x560) com o logo Z e um slogan

## Justificativa de permissões — CWS exige explicação

Na seção **Privacy Practices** do formulário, o reviewer vai pedir justificativa pra cada permissão do `manifest.json`. Textos prontos:

### `storage`
> Necessário para armazenar localmente a chave de acesso do usuário, o
> ID do dispositivo (UUID anônimo) e o estado da sessão entre reloads.
> Nenhum dado do conteúdo do usuário é salvo via chrome.storage —
> scripts e áudios ficam em IndexedDB local, inacessíveis ao servidor.

### `activeTab`
> Necessário para que o popup, ao ser acionado pelo usuário, execute um
> script na aba ativa do WhatsApp Web para extrair o número do usuário
> logado a partir do localStorage. Este é o único momento em que a
> extensão acessa a tab ativa fora do content script declarado.

### `scripting`
> Necessário para o popup executar o script descrito acima
> (chrome.scripting.executeScript) quando o usuário clica "Ativar" e
> precisa validar a chave contra o backend.

### `alarms`
> Necessário para o heartbeat periódico (a cada 30 minutos) que
> revalida a chave de acesso do usuário com o backend. Sem isso, uma
> chave revogada continuaria funcionando até o próximo reload manual.

### `host_permissions`: `https://web.whatsapp.com/*`
> O content script da extensão roda em web.whatsapp.com para injetar a
> sidebar, quickbar e funcionalidades de envio. Sem essa permissão a
> extensão não teria como operar — é o core do produto.

### `host_permissions`: `https://zapfire-production.up.railway.app/*`
> Domínio do backend de licenciamento. A extensão faz requisições para
> validar a chave do usuário, registrar dispositivos e fazer heartbeat.
> É a única comunicação com servidor remoto que a extensão realiza.

### `host_permissions`: `https://api.zapfire.com.br/*`
> Domínio reservado para o backend em produção (após migração do domínio
> Railway pra zapfire.com.br). Não usa tráfego até a migração mas está
> na lista pra evitar updates de manifest quebrando a extensão no
> processo.

### `content_scripts` no `web.whatsapp.com`
> ISOLATED world (content.js): gerencia a sidebar, quickbar e bridge
> entre iframes. MAIN world (injected.js + vendor/wppconnect-wa.js):
> acessa a API interna do WhatsApp Web (Store hijacking via WA-JS) pra
> envio de mensagens diretamente pelo protocolo, sem depender do DOM.
> Isso permite envios em segundo plano, múltiplas conversas em paralelo.

## Single-purpose policy (obrigatório)

Nova política do CWS: extensão tem que ter um propósito único. Texto pronto:

> Zapfire tem um único propósito: aumentar a produtividade de usuários
> do WhatsApp Web que usam a plataforma para atendimento comercial,
> oferecendo uma biblioteca de respostas pré-programadas (texto, áudio,
> mídia) e sequências automatizadas (funis). Todas as funcionalidades
> giram em torno desse objetivo.

## Data usage disclosure (obrigatório)

Checkbox no formulário ("Coletamos dados do usuário?"). Marque **SIM** e
declare:

- ☑ Personally identifiable information (apenas email)
- ☑ Authentication information (chave hex aleatória, não é senha)
- ☑ Location (apenas IP do request, não GPS)
- ☐ Health information (não coletamos)
- ☐ Financial information (não coletamos — paga via Kirvano)
- ☐ Web history (não coletamos)
- ☐ User activity (conteúdo dos items NÃO sai do navegador)
- ☐ Website content (não coletamos)
- ☑ Personal communications (coletamos o número do WhatsApp do próprio
    usuário para vincular a chave — é o telefone dele, não de terceiros)

Marque todas as afirmações:
- ☑ Não vendemos dados a terceiros
- ☑ Não usamos dados para propósitos não relacionados à funcionalidade principal
- ☑ Não usamos dados para determinar crédito ou empréstimos

## Privacy Policy URL

```
https://zapfire-five.vercel.app/privacy
```

(Confirme que a página está live antes de submeter — faça deploy do painel
com a versão que inclui /privacy).

## Passo a passo da submissão

1. **Acessa** [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole/)
2. Paga $5 se for a primeira vez
3. **New item** → upload do `zapfire-extension-0.1.0.zip`
4. Aba **Package**: confere versão, ícone, permissões (já vêm do manifest)
5. Aba **Store listing**:
   - Cole nome, summary, description (textos acima)
   - Upload dos screenshots (1280x800 ou 640x400)
   - Upload do small promo tile (440x280)
   - Categoria: Productivity
   - Idioma: Portuguese (Brazil)
6. Aba **Privacy practices**:
   - Cole a Privacy Policy URL
   - Responda cada pergunta com os textos acima
   - Marque os checkboxes de data usage conforme descrito
7. Aba **Distribution**:
   - Visibility: **Public** (ou **Unlisted** se quiser testar distribuindo
     o link antes, sem aparecer na busca)
   - Países: **Apenas Brasil** (o produto é pt-BR; pode abrir depois)
8. **Submit for review**
9. Wait — review costuma levar 1–3 dias úteis, podendo chegar a 2 semanas
   dependendo da complexidade

## O que pode fazer o review ser rejeitado

- ❌ Permissões sem justificativa clara
- ❌ Privacy Policy URL que retorna 404 ou não descreve as coletas
- ❌ Screenshots mostrando conteúdo fake ou placeholder lorem ipsum
- ❌ Ofuscação pesada do JS (minify é OK — a gente usa esbuild)
- ❌ Content script rodando fora dos domínios declarados
- ❌ Fallback code que executa coisas não descritas (ex: um banner popup
   oculto que aparece no WhatsApp e não é core da feature descrita)
- ❌ Falta de menção a como o usuário remove seus dados

Se rejeitar, o Google manda email com o motivo. Corrige e resubmete — não
reseta nada.

## Depois de aprovado

- URL fixa: `https://chrome.google.com/webstore/detail/<slug>/<id>`
- Updates: basta subir novo zip com `version` bumped no `manifest.json`.
  Fica em review denovo mas é mais rápido (1 dia em geral pra updates
  minor)
- **Desabilita a extensão dev** que você tinha unpacked — agora quem é
  cliente instala pela Chrome Web Store

## Checklist final antes de submeter

- [ ] `package.json` do backend e extensão com `version` atual
- [ ] `manifest.json` com `version` sincronizada
- [ ] Build de prod gerado: `npm run build` em `extension/`
- [ ] Privacy policy deployada e acessível: GET `/privacy` retorna 200 HTML
- [ ] Screenshots preparadas (mínimo 1, idealmente 3–5)
- [ ] Small promo tile 440x280 pronto
- [ ] Backend Railway + painel Vercel no ar e healthy
- [ ] Kirvano webhook apontando pra Railway
- [ ] Domínio do Resend verificado (se for usar email real)
- [ ] Seed rodada em prod (admin + test key existem)
