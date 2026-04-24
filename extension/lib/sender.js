// ============================================================
// ZAPFIRE — Sender
// ============================================================
// Funções que enviam coisas no chat ATUALMENTE ABERTO do
// WhatsApp Web. Esse módulo é chamado SEMPRE pelo content
// script (precisa do DOM real do web.whatsapp.com).
//
// Todas as funções retornam { ok: boolean, error?: string }.
//
// ATENÇÃO — fragilidade conhecida:
//   O WA Web muda seletores periodicamente. Cada função tem
//   uma cascata de seletores fallback. Se algo parar de
//   funcionar, comece olhando aqui.
//
// TODO (Sprint 3 — Parte D):
//   sendAudioAsVoice() — primeira versão usa o input file
//   normal, então o áudio aparece como "arquivo de áudio"
//   (não como "mensagem de voz"). A versão real (com
//   waveform de PTT) precisa hookar o MediaRecorder e ainda
//   está pendente.
// ============================================================

// ------------------------------------------------------------
// Helpers de localização de elementos
// ------------------------------------------------------------

// Caixa de digitação do chat aberto. WA Web usa contenteditable
// dentro do <footer> da coluna principal. Vários seletores são
// tentados pra resistir a renames de aria-label.
function findChatInput() {
  const selectors = [
    'footer div[contenteditable="true"][data-tab="10"]',
    'footer div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="mensagem" i]',
    'div[contenteditable="true"][aria-label*="message" i]',
    'footer div[contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// Botão de enviar (avião de papel). Quando o input está vazio,
// esse botão pode não existir — em vez disso há o ícone de
// microfone. Sempre cheque após inserir texto.
function findSendButton() {
  const selectors = [
    'footer button[aria-label*="Enviar" i]',
    'footer button[aria-label*="Send" i]',
    'footer [data-icon="wds-ic-send-filled"]',
    'footer [data-icon="send"]',
    'span[data-icon="send"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      // Se vier um <span data-icon>, sobe pro botão clicável real
      return el.closest('button') || el.closest('[role="button"]') || el;
    }
  }
  return null;
}

// Confere se há um chat aberto. Sem chat, não dá pra enviar nada.
export function isChatOpen() {
  return !!findChatInput();
}

// Tenta extrair o nome do contato/grupo do chat aberto. Usado
// pra exibir "Enviando para Fulano..." na sidebar. Pode falhar
// silenciosamente.
export function getOpenChatName() {
  const selectors = [
    '#main header [data-testid="conversation-info-header-chat-title"]',
    '#main header span[dir="auto"][title]',
    '#main header span[title]',
    '#main header div[role="button"] span[dir="auto"]',
    '#main header span[dir="auto"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.getAttribute('title') || el.textContent || '').trim();
      if (text) return text;
    }
  }
  return null;
}

// ------------------------------------------------------------
// Espera curta — útil pra dar tempo pro React processar
// ------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Espera um seletor aparecer (ou expira)
async function waitFor(fn, { timeout = 3000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = fn();
    if (el) return el;
    await sleep(interval);
  }
  return null;
}

// ============================================================
// sendText(text)
// ============================================================
// Coloca o texto no input e dispara o envio. Não usa clipboard.
//
// Estratégia:
//   1. Foca o contenteditable
//   2. Usa document.execCommand('insertText', ...) — esse comando
//      dispara os eventos certos pro React do WA reconhecer o
//      conteúdo. É deprecated mas funciona em Chrome e é o
//      método mais confiável conhecido pra esse caso de uso.
//   3. Aguarda o botão de envio aparecer (ele só renderiza
//      quando há texto) e clica.
// ============================================================
export async function sendText(text) {
  if (typeof text !== 'string' || !text.length) {
    return { ok: false, error: 'Texto vazio' };
  }

  const input = findChatInput();
  if (!input) {
    return { ok: false, error: 'Nenhuma conversa aberta' };
  }

  try {
    input.focus();
    // Pequeno delay pra garantir foco
    await sleep(30);

    const success = document.execCommand('insertText', false, text);

    if (!success) {
      // Fallback — algumas versões do Chrome não retornam true
      // mesmo tendo inserido. Tentamos validar pelo texto visível.
      const evt = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: 'insertText',
      });
      input.dispatchEvent(evt);
    }

    // Espera o botão de send renderizar (depende do React processar
    // o input)
    const sendBtn = await waitFor(findSendButton, { timeout: 2000 });
    if (!sendBtn) {
      return { ok: false, error: 'Botão de envio não apareceu' };
    }

    sendBtn.click();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ============================================================
// sendMedia(blob, caption, type)
// ============================================================
// Envia imagem, vídeo ou arquivo no chat aberto.
//
// type: 'image' | 'video' | 'file'
//   - 'image' e 'video' usam o mesmo input do WA (accept de
//     image/* e video/*)
//   - 'file' usa o input de documento (accept "*")
//
// Estratégia:
//   1. Acha o <input type="file"> escondido apropriado pro tipo.
//      Em WA Web atual eles existem sempre no DOM, ocultos.
//      Se não existirem, tenta clicar no botão de anexo pra
//      mountar e refaz a busca.
//   2. Snapshot dos botões "send" existentes ANTES de disparar o
//      change (precisamos detectar o NOVO send button do
//      preview, distinto do send do chat).
//   3. Cria um File via DataTransfer, atribui a input.files,
//      dispatcha 'change'. WA abre o modal de preview.
//   4. Espera o novo send button aparecer no DOM.
//   5. Se houver caption, preenche no contenteditable do
//      preview (que está FORA do <footer> — é assim que ele se
//      diferencia do input principal de mensagem).
//   6. Clica no novo send button.
// ============================================================

function mimeToExt(mime) {
  if (!mime) return 'bin';
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
  };
  return map[mime.split(';')[0].toLowerCase()] || mime.split('/')[1] || 'bin';
}

function guessFilename(blob, type, hint) {
  if (hint) return hint;
  const ext = mimeToExt(blob.type);
  return `zapfire-${type}-${Date.now()}.${ext}`;
}

// Encontra o input file apropriado pro tipo desejado.
//
// WA Web costuma ter VÁRIOS <input type="file"> escondidos no
// DOM, um pra cada item do menu de anexo:
//   - Figurinha:    accept="image/png,image/webp,..."  (só imagem)
//   - Foto e Vídeo: accept="image/*,video/mp4,..."     (image E video)
//   - Documento:    accept="*"                         (qualquer)
//   - Áudio:        accept="audio/*"                   (em algumas versões)
//
// Pegar "o primeiro com image no accept" cai no input de figurinha
// e: PNG entra como sticker, MP4 e .txt são rejeitados. A heurística
// abaixo escolhe o input correto pra cada tipo.
function findFileInput(type) {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));

  const acceptOf = (inp) => (inp.accept || '').toLowerCase();
  const accepts = (inp, ...keywords) => {
    const a = acceptOf(inp);
    return keywords.every((k) => a.includes(k));
  };

  if (type === 'image' || type === 'video') {
    // 1) Input "Foto e Vídeo" — aceita image E video juntos
    const photoVideo = inputs.find((inp) => accepts(inp, 'image', 'video'));
    if (photoVideo) return photoVideo;

    // 2) Fallbacks específicos por tipo
    if (type === 'video') {
      const v = inputs.find((inp) => acceptOf(inp).includes('video'));
      if (v) return v;
    }
    if (type === 'image') {
      // Aqui pode ser figurinha — último recurso
      const i = inputs.find((inp) => acceptOf(inp).includes('image'));
      if (i) return i;
    }
    return null;
  }

  if (type === 'file') {
    // 1) Input de documento — accept genérico
    const doc = inputs.find((inp) => {
      const a = (inp.accept || '').trim();
      return a === '' || a === '*' || a === '*/*';
    });
    if (doc) return doc;

    // 2) Fallback — qualquer input que NÃO seja específico de mídia
    const generic = inputs.find((inp) => {
      const a = acceptOf(inp);
      return !a.includes('image') && !a.includes('video') && !a.includes('audio');
    });
    if (generic) return generic;
  }

  if (type === 'audio') {
    // 1) Input específico de áudio (algumas versões têm)
    const audio = inputs.find((inp) => acceptOf(inp).includes('audio'));
    if (audio) return audio;
    // 2) Fallback pro input de documento
    const doc = inputs.find((inp) => {
      const a = (inp.accept || '').trim();
      return a === '' || a === '*' || a === '*/*';
    });
    if (doc) return doc;
  }

  return null;
}

function findAttachButton() {
  const selectors = [
    'footer [data-icon="plus-rounded"]',
    'footer [data-icon="plus"]',
    'footer [data-icon="clip"]',
    'footer [data-icon="attach-menu-plus"]',
    'footer button[title*="Anexar" i]',
    'footer button[title*="Attach" i]',
    'footer button[aria-label*="Anexar" i]',
    'footer button[aria-label*="Attach" i]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el.closest('button') || el.closest('[role="button"]') || el;
  }
  return null;
}

async function ensureFileInput(type) {
  let input = findFileInput(type);
  if (input) return input;

  // Tenta acionar o menu de anexo pra mountar os inputs
  const attach = findAttachButton();
  if (attach) {
    attach.click();
    await sleep(200);
    input = await waitFor(() => findFileInput(type), { timeout: 2000 });
    // Fecha o menu (ESC) — não queremos deixar aberto
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  }
  return input;
}

// Coleta todos os "spans/divs com data-icon=send" atualmente no DOM.
// Usado pra detectar o NOVO send button que aparece quando o
// preview do anexo abre.
function snapshotSendButtons() {
  const set = new Set();
  document.querySelectorAll('[data-icon="send"], [data-icon="wds-ic-send-filled"]').forEach(
    (el) => set.add(el)
  );
  return set;
}

function findNewSendButton(before) {
  const all = document.querySelectorAll('[data-icon="send"], [data-icon="wds-ic-send-filled"]');
  for (const el of all) {
    if (!before.has(el)) {
      return el.closest('button') || el.closest('[role="button"]') || el;
    }
  }
  return null;
}

// O caption do preview é um contenteditable que NÃO está dentro
// do <footer> (que é o input principal de mensagem). Achar o
// primeiro contenteditable fora do footer.
function findPreviewCaptionInput() {
  const editables = document.querySelectorAll('div[contenteditable="true"]');
  for (const el of editables) {
    if (!el.closest('footer')) return el;
  }
  return null;
}

// ------------------------------------------------------------
// Esconde o modal de preview de mídia do WA durante envios
// programáticos. Estratégia dupla:
//   1) Regra CSS pra cobrir seletores conhecidos
//   2) MutationObserver que detecta QUALQUER overlay novo
//      aparecendo no DOM e esconde imediatamente (fallback pra
//      quando os seletores mudam)
// Como clicamos no botão de send via JS, não precisamos do
// modal estar visível.
// ------------------------------------------------------------
const MODAL_HIDER_ID = 'zf-media-modal-hider';
let modalObserver = null;

// LIMITAÇÃO CONHECIDA — não é possível esconder 100% o editor
// de mídia do WA Web sem hookar no Store interno do WA (React
// internals). A janela visível é minimizada por:
//   1. CSS escondendo os testids do editor (canvas, caption,
//      toolbar)
//   2. Disable de transitions/animations (sem fade-in)
//   3. Click no send disparado o mais rápido possível (poll de
//      30ms pra detectar o botão novo)
// O resultado: o editor "pisca" por ~100-200ms.
// Bypass total = trabalho de outro sprint (Store hijacking).
function injectModalHider() {
  if (document.getElementById(MODAL_HIDER_ID)) return;

  const style = document.createElement('style');
  style.id = MODAL_HIDER_ID;
  style.textContent = `
    [data-testid="media-editor-canvas"],
    [data-testid="media-caption-input-container"],
    [data-testid="media-composer"],
    [data-testid="image-preview"],
    [data-testid="video-preview"],
    [data-testid="document-preview"],
    [data-testid="audio-preview"],
    [data-testid*="composer"],
    [data-testid*="-preview"],
    [data-testid="close-button"],
    [data-testid="crop-rotate-button"],
    [data-testid="filter-button"],
    [data-testid="paint-button"],
    [data-testid="text-button"],
    [data-testid="shape-button"],
    [data-testid="blur-button"],
    [data-testid="emoji-button"],
    [data-testid="sticker-button"],
    [data-testid="ic-download"] {
      visibility: hidden !important;
      transition: none !important;
      animation: none !important;
    }
  `;
  document.head.appendChild(style);
}

function removeModalHider() {
  const el = document.getElementById(MODAL_HIDER_ID);
  if (el) el.remove();
}

// ------------------------------------------------------------
// Estratégia 1: paste simulado no input do chat (PRIMÁRIA)
// ------------------------------------------------------------
// É a ÚNICA estratégia 100% ancorada ao chat aberto. WA Web
// aceita paste de arquivos nativamente (você pode copiar uma
// imagem no clipboard e colar no chat). Como o paste é
// dispatchado no contenteditable do footer do #main (= o
// input da conversa aberta), não há ambiguidade de
// destinatário.
//
// Detalhes:
//   - Construímos um ClipboardEvent com clipboardData populado
//     via DataTransfer.
//   - Em algumas versões do Chrome, o construtor IGNORA o
//     clipboardData passado no init. Forçamos via
//     Object.defineProperty pra contornar.
// ------------------------------------------------------------
function buildPasteEvent(file) {
  const dt = new DataTransfer();
  dt.items.add(file);

  let event;
  try {
    event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
  } catch (_) {
    event = new Event('paste', { bubbles: true, cancelable: true });
  }

  // Alguns Chrome ignoram o clipboardData do init — força aqui
  if (event.clipboardData !== dt) {
    try {
      Object.defineProperty(event, 'clipboardData', {
        value: dt,
        configurable: true,
      });
    } catch (_) {
      // sem ação — se falhar, seguimos pro fallback de drop
    }
  }
  return event;
}

async function tryPaste(file, before) {
  const input = findChatInput();
  if (!input) return null;

  try {
    input.focus();
    await sleep(50);
    input.dispatchEvent(buildPasteEvent(file));
  } catch (_) {
    return null;
  }

  return await waitFor(() => findNewSendButton(before), {
    timeout: 4000,
    interval: 30,
  });
}

// ------------------------------------------------------------
// Estratégia 2: drag-and-drop no footer do chat aberto
// ------------------------------------------------------------
// Dispatchar no #main genérico fez o WA abrir um picker de
// contato em vez do preview do chat. Mirando no FOOTER do
// #main (que pertence inequivocamente à conversa aberta), o
// drop é roteado pro chat correto.
// ------------------------------------------------------------
async function tryDragAndDrop(file, before) {
  const target =
    document.querySelector('#main footer') ||
    document.querySelector('#main') ||
    null;

  if (!target) return null;

  const dt = new DataTransfer();
  dt.items.add(file);

  const init = { bubbles: true, cancelable: true, dataTransfer: dt };

  try {
    target.dispatchEvent(new DragEvent('dragenter', init));
    target.dispatchEvent(new DragEvent('dragover', init));
    target.dispatchEvent(new DragEvent('drop', init));
  } catch (_) {
    return null;
  }

  return await waitFor(() => findNewSendButton(before), {
    timeout: 4000,
    interval: 30,
  });
}

// ------------------------------------------------------------
// Estratégia 3: file input direto (FALLBACK)
// ------------------------------------------------------------
// Último recurso. Pode mandar imagem como figurinha em algumas
// versões do WA por causa do mounting lazy de inputs.
// ------------------------------------------------------------
async function tryFileInput(file, type, before) {
  const input = await ensureFileInput(type);
  if (!input) return null;

  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  return await waitFor(() => findNewSendButton(before), {
    timeout: 6000,
    interval: 30,
  });
}

export async function sendMedia(blob, caption = '', type = 'file') {
  if (!(blob instanceof Blob)) {
    return { ok: false, error: 'Blob inválido' };
  }
  if (!isChatOpen()) {
    return { ok: false, error: 'Nenhuma conversa aberta' };
  }

  // Esconde o preview do WA durante todo o envio. Como clicamos
  // no botão de send via JS, o usuário não precisa ver o modal.
  injectModalHider();

  try {
    const filename = guessFilename(blob, type, blob.name);
    const file = new File([blob], filename, {
      type: blob.type || 'application/octet-stream',
    });

    const before = snapshotSendButtons();

    // 1) Paste — anchored ao chat aberto via input
    let sendBtn = await tryPaste(file, before);
    let strategyUsed = 'paste';

    // 2) Drag-and-drop no footer
    if (!sendBtn) {
      sendBtn = await tryDragAndDrop(file, before);
      strategyUsed = 'drop';
    }

    // 3) File input direto
    if (!sendBtn) {
      sendBtn = await tryFileInput(file, type, before);
      strategyUsed = 'input';
    }

    if (!sendBtn) {
      const detected = Array.from(document.querySelectorAll('input[type="file"]'))
        .map((i) => i.accept || '(vazio)')
        .join(' | ');
      return {
        ok: false,
        error: `Preview não abriu (paste+drop+input falharam). Accepts: [${detected || 'nenhum'}]`,
      };
    }

    console.log('[Zapfire] sendMedia via', strategyUsed);

    // Caption opcional
    if (caption && caption.length) {
      const captionInput = await waitFor(findPreviewCaptionInput, { timeout: 1500 });
      if (captionInput) {
        captionInput.focus();
        await sleep(50);
        document.execCommand('insertText', false, caption);
        await sleep(150);
      }
    }

    // Click imediato — o overlay já está cobrindo o WA
    sendBtn.click();
    // Aguarda o WA processar e o modal sumir
    await sleep(250);
    return { ok: true, strategy: strategyUsed };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    removeModalHider();
  }
}

// ============================================================
// sendAudioAsVoice(blob)
// ============================================================
// MVP — envia o áudio como ANEXO (aparece como "arquivo de
// áudio" no chat, com player). Reusa o pipeline do sendMedia
// (paste → drop → input), com type='audio'. WA Web reconhece
// o MIME e renderiza o player.
//
// TODO — Iteração futura (PTT real / mensagem de voz):
//   Pra parecer GRAVAÇÃO AO VIVO (sem ícone de arquivo, com
//   waveform de PTT, sem tag "Encaminhada"), o caminho é:
//     1. Converter o blob pra audio/ogg; codecs=opus mono 16kHz
//        (OfflineAudioContext + opus-media-recorder ou nativo).
//     2. Hookar window.MediaRecorder pra interceptar a gravação
//        que o WA inicia quando o usuário segura o botão de PTT.
//     3. Devolver o blob convertido como se fosse a gravação
//        real, e disparar o "soltar" do PTT.
//   Fica complexo e frágil — só vale a pena se houver feedback
//   forte dos usuários pedindo. Por ora, "anexo de áudio"
//   atende o caso de uso (afiliado X1 envia áudio pré-gravado).
// ============================================================
export async function sendAudioAsVoice(blob) {
  if (!(blob instanceof Blob)) {
    return { ok: false, error: 'Blob inválido' };
  }
  if (!isChatOpen()) {
    return { ok: false, error: 'Nenhuma conversa aberta' };
  }

  // Garante que o blob carrega um MIME type de áudio. Se vier
  // octet-stream ou vazio, força audio/ogg como default.
  let workBlob = blob;
  if (!blob.type || !blob.type.startsWith('audio/')) {
    workBlob = blob.slice(0, blob.size, 'audio/ogg');
  }

  // Reusa o pipeline de mídia. type='audio' é só pra nomear o
  // arquivo — o roteamento do WA é por MIME, não por extensão.
  return sendMedia(workBlob, '', 'audio');
}
