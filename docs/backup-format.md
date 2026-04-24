# Backup format — compatibilidade com ZapVoice 3.0.0

> **Status**: implementado e testável via modal "Backup" do manager. Permite que clientes migrem do ZapVoice pro Zapfire (e vice-versa) sem perder funis, mensagens, áudios, mídias ou documentos.

- **Módulo principal**: [`extension/lib/backup.js`](../extension/lib/backup.js)
- **Storage**: [`extension/lib/storage.js`](../extension/lib/storage.js) (helpers `putItem` / `putFunnel` adicionados pra suportar `conflictMode: 'overwrite'`)
- **UI**: modal "Backup" na topbar do manager — [`extension/manager/manager.html`](../extension/manager/manager.html) + [`extension/manager/manager.js`](../extension/manager/manager.js)
- **Versão alvo**: `3.0.0` (formato fixo conforme exporta o ZapVoice atualmente)

## Decisão fundacional

O Zapfire usa internamente **um único `items` store** (com `type: 'text' | 'audio' | 'image' | 'video' | 'file'`), enquanto o ZapVoice particiona em 4 coleções (`audios`, `medias`, `docs`, `messages`) + 1 lista flat de objetos (`objectsList`). O módulo de backup faz a tradução nos dois sentidos sem mudar o storage interno.

Optamos por **manter o formato ZapVoice como nosso formato canônico de backup** porque:

1. Cliente vindo do ZapVoice exporta lá → importa aqui sem fricção (proposta de valor explícita);
2. Cliente do Zapfire pode levar o backup pro ZapVoice se um dia quiser sair, reduzindo lock-in percebido;
3. Single source-of-truth pra documentar — não inventamos formato próprio.

Trade-off: o formato ZV tem alguns campos sem sentido pro Zapfire (`flows`, `triggers`, `labels`) que viram arrays vazios, e o storage interno tem campos novos (`isPtt`, `isPtv`, `asViewOnce`, `mentionUsers`, `caption`, `fileName`, `isFavorite`) que precisam ser preservados na ida e volta.

## Schema raiz

```json
{
  "version": "3.0.0",
  "type": "full",
  "audios":   [ ... metadados de áudios ],
  "docs":     [ ... metadados de documentos ],
  "medias":   [ ... metadados de imagens/vídeos ],
  "messages": [ ... metadados de scripts de texto ],
  "funnels":  [ ... funis com itemsSequence ],
  "flows":    [],
  "triggers": [],
  "labels":   [],
  "objectsList": [ ... conteúdo binário/texto referenciado por id ]
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `version` | `string` | `"3.0.0"`. Backups com `3.x.x` são aceitos com warning. Outras versões geram aviso "vai tentar mesmo assim". |
| `type` | `"full" \| "partial"` | Ainda não diferenciamos comportamento. `"full"` no export do Zapfire. |
| `audios` / `medias` / `docs` / `messages` | `array` | Metadados (ver schemas abaixo). |
| `funnels` | `array` | Funis com referências por id. |
| `flows` / `triggers` / `labels` | `array` | Não implementados no Zapfire — sempre `[]` no export, ignorados no import. |
| `objectsList` | `array` | Conteúdo real (data URI ou string crua), referenciado por `id`. |

## Schema das coleções

### `audios[]`

```json
{
  "id": "9f8c4e9d-5d68-4095-a05e-b7e7762f786d",
  "name": "teste",
  "isPtt": true,
  "isFavorite": false,
  "asViewOnce": false,
  "mentionUsers": "none"
}
```

### `medias[]` (imagens e vídeos)

```json
{
  "id": "f950777b-54ff-4f54-a99a-954fc5c25cf5",
  "name": "branco",
  "isFavorite": false,
  "asViewOnce": false,
  "isPtv": false,
  "mentionUsers": "none"
}
```

`isPtv = true` indica vídeo redondo (push-to-video). Em metadados ZV, image vs video só é determinado lendo o MIME do `objectsList[i].data` correspondente — o metadado em si é compartilhado.

### `docs[]`

```json
{
  "id": "3d1cf6df-...",
  "name": "relatório_cliente",
  "isFavorite": false,
  "mentionUsers": "none"
}
```

### `messages[]` (scripts de texto)

```json
{
  "id": "e9661c6e-...",
  "name": "OI",
  "isFavorite": false,
  "mentionUsers": "none"
}
```

### `funnels[]`

```json
{
  "id": "72cdb593-...",
  "name": "funil",
  "isFavorite": false,
  "itemsSequence": [
    {
      "id": "41f73c79-...",
      "funnelId": "72cdb593-...",
      "itemId": "e9661c6e-...",
      "type": "message",
      "delayBeforeSend": 63000
    }
  ]
}
```

| Campo do step | Tipo | Notas |
|---|---|---|
| `id` | `string` | UUID do step (não usado pelo Zapfire — descartado no import; gerado no export). |
| `funnelId` | `string` | Redundante (igual ao `funnels[].id` pai). Gerado no export, ignorado no import. |
| `itemId` | `string` | **Aponta** pra um id em `audios` / `medias` / `docs` / `messages`. |
| `type` | `"message" \| "audio" \| "media" \| "document"` | Pista pro consumidor. No Zapfire descartamos no import (o type é inferido lendo o item referenciado). |
| `delayBeforeSend` | `int` (ms) | Mapeia pra `step.delayMs` interno. |

### `objectsList[]`

Cada entry é referenciada por `id` por algum metadado. **Campos variam por categoria**:

**Áudio:**
```json
{
  "id": "9f8c4e9d-...",
  "isPtt": true,
  "data": "data:audio/mpeg;base64,//vgbAAP..."
}
```

**Documento:**
```json
{
  "id": "3d1cf6df-...",
  "fileName": "relatorio.jpg",
  "data": "data:image/jpeg;base64,..."
}
```

**Mídia (imagem ou vídeo):**
```json
{
  "id": "f950777b-...",
  "caption": "",
  "data": "data:image/jpeg;base64,..."
}
```

**Texto (message):**
```json
{
  "id": "e9661c6e-...",
  "data": "OI, tudo bem?"
}
```

**Importante**: `data` em `messages` é **string crua**, não data URI. Em todos os outros tipos é data URI (`data:<mime>;base64,...`).

## Mapeamento de tipos

### Import (ZapVoice → Zapfire interno)

| Origem | type interno | Campos preservados |
|---|---|---|
| `audios[]` | `'audio'` | `isPtt` (de `obj.isPtt` ou metadado), `asViewOnce`, `isFavorite`, `mentionUsers` |
| `medias[]` + MIME `image/*` | `'image'` | `caption` (de `obj`), `asViewOnce`, `isFavorite`, `mentionUsers` |
| `medias[]` + MIME `video/*` | `'video'` | `caption`, `isPtv`, `asViewOnce`, `isFavorite`, `mentionUsers` |
| `docs[]` | `'file'` | `fileName` (de `obj`), `isFavorite`, `mentionUsers` |
| `messages[]` | `'text'` | `content` recebe a string crua de `obj.data`; `isFavorite`, `mentionUsers` |

`name` do metadado vira `title` interno em todos os casos.

### Export (Zapfire interno → ZapVoice)

Inverso. O dispatcher é por `item.type`:

- `'text'` → `messages[]` + entry com `data: <string>`
- `'audio'` → `audios[]` + entry com `isPtt`, `data: <data URI>`
- `'image'` → `medias[]` (com `isPtv: false`) + entry com `caption`, `data: <data URI>`
- `'video'` → `medias[]` (com `isPtv` preservado) + entry com `caption`, `data: <data URI>`
- `'file'` → `docs[]` + entry com `fileName`, `data: <data URI>`

### Mapeamento de `step.type` em funis

| Internal type | ZV step type |
|---|---|
| `text` | `message` |
| `audio` | `audio` |
| `image` | `media` |
| `video` | `media` |
| `file` | `document` |

No export é resolvido via index `id → type` construído a partir dos items já carregados (evita N getItems).

No import o `step.type` é descartado: o type real é o do item que `itemId` referencia.

## Comportamento defensivo

### Itens órfãos

Se um metadado (`audios[i]`) referencia um id que não existe em `objectsList`, o item é **pulado** no import e o id vai pro array `report.orphans`. Mesma lógica vale na direção oposta (object sem metadado correspondente → ignorado).

### Steps com `itemId` inexistente

Pulados silenciosamente. Funil entra mesmo assim com os steps válidos. Se todos os steps forem inválidos, o funil inteiro vai pra `skipped.funnels`.

### Erros por item

Cada item/funil tem try/catch próprio. Um item corrompido não derruba a importação — vai pro `report.errors[]` com `{id, kind, message}` e o resto segue.

### Versão divergente

Backup com `version` diferente de `3.x.x` é importado mesmo assim, com warning na UI. Campos novos podem não ser reconhecidos.

## Modos de conflito (`conflictMode`)

Quando um item ou funil do backup tem o mesmo `id` que algo já no storage:

| Modo | Comportamento |
|---|---|
| `'skip'` (default) | Ignora a entrada do backup. O que tá no storage permanece intocado. Conta em `report.skipped.<categoria>`. |
| `'overwrite'` | Substitui o item/funil existente via `putItem` / `putFunnel`. `createdAt` do backup é preservado (diferente de `updateItem`, que mantém o do existente). |
| `'rename'` | Gera UUID novo + adiciona `" (importado)"` ao nome. **Atualiza o `idMap` interno** pra que funis processados depois apontem pra essa nova versão renomeada. |

## Flag `regenerateIds`

Quando `true`, o import gera UUIDs novos pra **todos** os items e funis antes de inserir. O mapping `oldId → newId` é mantido em memória (`idMap`) e usado quando os funis são processados (sempre por último) pra atualizar `step.itemId` automaticamente.

Útil pra **duplicar** todo o conteúdo dum backup numa conta já populada sem risco de colisão. Se também passar `conflictMode: 'rename'`, o rename nunca dispara (porque os ids são todos novos e nunca colidem) — comportamento correto, sem regressão.

## ImportReport

Retornado por `importBackup()`:

```js
{
  version: "3.0.0",
  imported: { audios: 1, medias: 2, docs: 1, messages: 1, funnels: 1 },
  skipped:  { audios: 0, medias: 0, docs: 0, messages: 0, funnels: 0 },
  orphans:  ["<id1>", "<id2>"],   // dedup'd
  errors:   [{ id: "...", kind: "audio", message: "..." }]
}
```

A UI do modal mostra esse report como tabela "Categoria | Importados | Pulados" + pills coloridos pra órfãos e erros.

## API pública

```js
import {
  SCHEMA_VERSION,        // '3.0.0'
  exportBackup,          // (options?) → Promise<Blob>
  importBackup,          // (input, options?) → Promise<ImportReport>
  previewBackup,         // (input) → Promise<{ counts, orphans, versionMismatch }>
  suggestBackupFilename, // (date?) → 'zapfire_backup_DD_MM_YYYY.json'
} from '../lib/backup.js';
```

`input` aceita `File`, `Blob`, string JSON ou objeto plano.

## Como migrar do ZapVoice (cliente final)

1. **No ZapVoice**: clica em "Exportar backup" — arquivo `ZV_backup_DD_MM_YYYY.json` é baixado.
2. **No Zapfire**: abre o gerenciador → topbar → botão **"Backup"** → seção "Importar backup" → "Selecionar arquivo .json" → escolhe o JSON.
3. Confere o preview (5 stat cards: Funis / Mensagens / Áudios / Mídias / Documentos).
4. Mantém modo de conflito `Pular` (default) — em conta nova não vai ter colisão de qualquer jeito.
5. Clica "Importar tudo" → tabela do report aparece embaixo.
6. Fecha o modal e os funis/mensagens/áudios já estão disponíveis nas tabs da sidebar e do manager.

## Round-trip (verificar correctness)

Test pra garantir que o módulo é semanticamente lossless:

1. Importa um backup ZapVoice qualquer.
2. Sem fechar nada, exporta backup.
3. Compara JSON resultante com o original. Pode diferir em ordem de propriedades JSON, mas todos os ids, names, flags, blobs (após decode) e steps devem bater.

Diferenças esperadas e benignas:
- Step `id` no `itemsSequence` sempre é regenerado no export (não persistimos esse id internamente).
- Ordem dos arrays segue ordem de inserção do IndexedDB (createdAt DESC) — pode diferir do ZV se ele usa outra ordem.

## Limitações conhecidas

- **MIME via `Blob.type`**: `fetch(dataURI).blob()` preserva mime na maioria dos casos, com fallback pra parsing manual da string `data:<mime>;...` em [`mimeOfDataUri`](../extension/lib/backup.js).
- **Texto sem encoding**: `messages[].data` é string crua em UTF-8 (limitação do JSON.stringify). Caracteres exóticos (emoji ZWJ sequences, surrogate pairs malformados) podem ter comportamento de borda.
- **Tamanho**: backups são carregados inteiros em memória (string JSON). Para libraries enormes (>~100MB com áudios em base64), pode dar OOM em devices limitados. Streaming JSON parser fica como melhoria futura se virar problema.
- **`flows` / `triggers` / `labels`**: aceitos no schema mas ignorados — features ainda não implementadas no Zapfire (Sprint 5+).

## Débitos técnicos

- `storage.exportAll` / `storage.importAll` (formato Zapfire `version: 1`) ainda existem em `lib/storage.js` como código morto. Não foram removidos pra não causar breaking change na API pública. Cleanup pass futuro pode remover.
- Conversão `dataURI → Blob` via `fetch(dataURI)` carrega o backup todo em memória pelo menos 2× (string original + blob decodificado por item). Não é problema pra backups normais (até dezenas de MB), mas pode ser otimizado com streaming se necessário.
