// ============================================================
// ZAPFIRE — Injected script (MAIN world)
// ============================================================
// Roda no contexto da página web.whatsapp.com.
//
// Carrega DEPOIS do WA-JS (wppconnect-wa-js.js) — que foi
// injetado primeiro via manifest. WA-JS expõe window.WPP com
// toda a API de envio de mídia/áudio/vídeo/documento funcional.
//
// Divisão de responsabilidades:
//   - TEXT:    usa nosso wrapper nativo (sendTextMsgToChat)
//              — mais leve, sem overhead do WPP
//   - MEDIA:   usa WPP.chat.sendFileMessage
//   - AUDIO:   usa WPP.chat.sendFileMessage com isPtt: true
//              (mensagem de voz REAL, não anexo de áudio)
//
// Bridge: content script (isolated) manda ZF_API_* via
// window.postMessage; injected escuta e responde.
// ============================================================

(function () {
  'use strict';

  if (window.__zfInjected) return;
  window.__zfInjected = true;

  const LOG = '[Zapfire][injected]';

  // ----------------------------------------------------------
  // Espera requisitos ficarem prontos
  // ----------------------------------------------------------
  const REQUIRED_NATIVE_MODULES = [
    'WAWebSendTextMsgChatAction',
    'WAWebChatCollection',
    'WAWebWidFactory',
  ];

  async function waitForRequire() {
    for (let i = 0; i < 600; i++) { // 60s total
      if (typeof window.require === 'function') return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function loadNativeModules() {
    const loaded = {};
    for (let i = 0; i < 120; i++) { // 60s
      let allReady = true;
      for (const name of REQUIRED_NATIVE_MODULES) {
        if (loaded[name]) continue;
        try {
          const m = window.require(name);
          if (m) loaded[name] = m;
          else allReady = false;
        } catch (_) { allReady = false; }
      }
      if (allReady) return loaded;
      await new Promise((r) => setTimeout(r, 500));
    }
    return loaded;
  }

  async function waitForWPP() {
    // WA-JS expõe window.WPP e window.WPP.isReady
    for (let i = 0; i < 180; i++) { // 90s
      if (window.WPP && window.WPP.isReady) return true;
      if (window.WPP && typeof window.WPP.waitReady === 'function') {
        try {
          await window.WPP.waitReady();
          return true;
        } catch (_) {}
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // ----------------------------------------------------------
  // Helpers (chat lookup) — mantidos da versão anterior
  // ----------------------------------------------------------
  function normalizeJid(input) {
    if (!input) return null;
    if (typeof input === 'object' && input._serialized) return input._serialized;
    let s = String(input).trim();
    if (/^\d+$/.test(s)) s = s + '@c.us';
    return s;
  }

  async function getChatNative(jid, nativeModules) {
    const factory = nativeModules.WAWebWidFactory;
    const col = nativeModules.WAWebChatCollection.ChatCollection;
    const wid = factory.createWid(jid);

    if (typeof col.get === 'function') {
      const c = col.get(wid._serialized || wid);
      if (c) return c;
    }
    if (typeof col.find === 'function') {
      try {
        const c = await col.find(wid);
        if (c) return c;
      } catch (_) {}
    }
    if (typeof col.getModelsArray === 'function') {
      const all = col.getModelsArray();
      const sid = wid._serialized || String(wid);
      const c = all.find((m) => (m.id?._serialized || m.id) === sid);
      if (c) return c;
    }
    return null;
  }

  // ----------------------------------------------------------
  // sendText — via módulos nativos (leve, já testado).
  // Fallback: se chat não existir (ex: enviar pra si mesmo pela
  // 1ª vez, ou JID em LID que não bate em ChatCollection), cai pro
  // WPP.chat.sendTextMessage que cria o chat se faltar.
  // ----------------------------------------------------------
  async function sendText(jid, text, nativeModules) {
    if (!jid || !text) throw new Error('jid e text são obrigatórios');
    if (typeof text !== 'string') throw new Error('text deve ser string');

    const chat = await getChatNative(jid, nativeModules);

    // Caminho rápido: chat já existe → usa módulo nativo
    if (chat) {
      let raw = nativeModules.WAWebSendTextMsgChatAction.sendTextMsgToChat(chat, text);
      if (raw && typeof raw.then === 'function') raw = await raw;
      if (Array.isArray(raw)) {
        const settled = await Promise.all(
          raw.map((p) => (p && typeof p.then === 'function' ? p : Promise.resolve(p)))
        );
        return { ok: true, localAck: settled[0], sendAck: settled[1], via: 'native' };
      }
      return { ok: true, result: raw, via: 'native' };
    }

    // Fallback: WPP.chat.sendTextMessage cria o chat se não existir
    if (window.WPP?.chat?.sendTextMessage) {
      try {
        const result = await window.WPP.chat.sendTextMessage(normalizeJid(jid), text, {
          createChat: true,
          waitForAck: false,
        });
        return { ok: true, id: result?.id?._serialized, ack: result?.ack, via: 'wpp-sendTextMessage' };
      } catch (e) {
        throw new Error(`WPP.chat.sendTextMessage falhou pra ${jid}: ${e.message || e}`);
      }
    }

    throw new Error(`chat não encontrado pra ${jid} (e WPP.chat.sendTextMessage indisponível)`);
  }

  // ----------------------------------------------------------
  // PTT — preparação dos bytes OGG/Opus antes do envio
  // ----------------------------------------------------------
  // Três causas de "áudio não disponível" no celular do destinatário
  // que esse bloco ataca:
  //
  // 1. Reuso de mídia por hash. O WA Web identifica mídia pelo
  //    SHA-256 dos bytes (filehash). Funil manda o MESMO arquivo pra
  //    dezenas de contatos, então o WA reaproveita um upload antigo
  //    (mesmo directPath/mediaKey) em vez de subir de novo. Quando
  //    esse upload expira no CDN, o destinatário não baixa e pede
  //    reenvio pro remetente — que geralmente falha. Resultado:
  //    "Este áudio não está disponível". Solução: cada envio ganha
  //    bytes únicos (um comentário ZFID=<random> no header OpusTags,
  //    CRC recalculado). O áudio em si não muda nem 1 sample.
  //
  // 2. Bytes que não são Opus mandados como PTT. Itens antigos da
  //    biblioteca (antes da 0.4.5) ou backups importados podem ser
  //    MP3/WAV com mimetype ogg. Android/iOS só tocam PTT em Opus.
  //    Se o sniff falhar, manda como áudio comum (anexo) com o
  //    mimetype real — toca em qualquer celular.
  //
  // 3. Pacote Opus vazio no fim do arquivo (ver stripEmptyOggPackets).
  //
  // 4. Duração/waveform ausentes. O WA-JS 4.x só calcula
  //    duration+waveform (precomputedFields) se options.waveform for
  //    truthy. Antes a gente passava `undefined` quando o nosso
  //    decode falhava, e o PTT saía sem duração (0:00) — o iPhone
  //    rejeita. Agora sempre passa `waveform: true`.
  // ----------------------------------------------------------

  // CRC-32 do Ogg: polinômio 0x04c11db7, sem reflexão, init 0.
  const OGG_CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) {
        r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
      }
      t[i] = r >>> 0;
    }
    return t;
  })();

  function oggCrc(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    }
    return crc;
  }

  const ascii = (u8, off, str) => {
    for (let i = 0; i < str.length; i++) {
      if (u8[off + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  };

  // Lê uma página Ogg em `off`. Retorna null se não for página válida.
  function readOggPage(u8, off) {
    if (off + 27 > u8.length || !ascii(u8, off, 'OggS')) return null;
    const nseg = u8[off + 26];
    const lacingEnd = off + 27 + nseg;
    if (lacingEnd > u8.length) return null;
    let bodyLen = 0;
    for (let i = off + 27; i < lacingEnd; i++) bodyLen += u8[i];
    const end = lacingEnd + bodyLen;
    if (end > u8.length) return null;
    return {
      off, nseg, bodyStart: lacingEnd, end,
      lastLacing: nseg ? u8[lacingEnd - 1] : 0,
    };
  }

  // Detecta o formato real pelos magic bytes (mimetype pode mentir).
  function sniffAudio(u8) {
    if (ascii(u8, 0, 'OggS')) {
      const p = readOggPage(u8, 0);
      if (p && ascii(u8, p.bodyStart, 'OpusHead')) return { kind: 'ogg-opus' };
      return { kind: 'ogg-other', mime: 'audio/ogg' };
    }
    if (ascii(u8, 0, 'ID3') || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0)) {
      return { kind: 'mp3', mime: 'audio/mpeg' };
    }
    if (ascii(u8, 0, 'RIFF')) return { kind: 'wav', mime: 'audio/wav' };
    if (ascii(u8, 4, 'ftyp')) return { kind: 'mp4', mime: 'audio/mp4' };
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
      return { kind: 'webm', mime: 'audio/webm' };
    }
    return { kind: 'unknown', mime: null };
  }

  // Recalcula e grava o CRC de uma página Ogg (bytes 22..25).
  function writeOggCrc(page) {
    page[22] = page[23] = page[24] = page[25] = 0;
    const crc = oggCrc(page);
    page[22] = crc & 0xff;
    page[23] = (crc >>> 8) & 0xff;
    page[24] = (crc >>> 16) & 0xff;
    page[25] = (crc >>> 24) & 0xff;
  }

  // Remove pacotes de 0 bytes das páginas de áudio. O
  // opus-media-recorder (usado no convertToOggOpus do manager) fecha
  // o arquivo com um pacote vazio na página EOS. Pacote Opus de 0
  // bytes é inválido (RFC 6716 §3.1 exige pelo menos o byte TOC):
  // ffmpeg acusa "Invalid data found when processing input" e os
  // decoders estritos dos apps do WhatsApp podem recusar o arquivo
  // inteiro. Todo áudio convertido pelo Zapfire tem isso — aqui
  // limpa na hora do envio, então itens já salvos também são
  // corrigidos sem precisar reconverter.
  // Retorna { bytes, removed }.
  function stripEmptyOggPackets(u8) {
    const parts = [];
    let removed = 0;
    let off = 0;
    while (off < u8.length) {
      const pg = readOggPage(u8, off);
      if (!pg) {
        // Lixo no fim do arquivo: descarta (não é página válida).
        break;
      }
      const lacing = u8.subarray(off + 27, pg.bodyStart);
      const continued = (u8[off + 5] & 0x01) !== 0;
      const keep = [];
      let inPacket = continued;
      let pktLen = 0;
      for (let i = 0; i < lacing.length; i++) {
        const v = lacing[i];
        const startsPacket = !inPacket;
        pktLen += v;
        if (v < 255) {
          // Pacote termina aqui. Se começou nesta lacing e tem 0
          // bytes, é o pacote vazio — não copia.
          if (startsPacket && pktLen === 0) {
            removed++;
          } else {
            keep.push(v);
          }
          inPacket = false;
          pktLen = 0;
        } else {
          keep.push(v);
          inPacket = true;
        }
      }
      if (keep.length === lacing.length) {
        parts.push(u8.subarray(off, pg.end));
      } else {
        const body = u8.subarray(pg.bodyStart, pg.end);
        const page = new Uint8Array(27 + keep.length + body.length);
        page.set(u8.subarray(off, off + 26), 0);
        page[26] = keep.length;
        page.set(keep, 27);
        page.set(body, 27 + keep.length);
        writeOggCrc(page);
        parts.push(page);
      }
      off = pg.end;
    }
    if (!removed && off === u8.length) return { bytes: u8, removed: 0 };
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let q = 0;
    for (const p of parts) { out.set(p, q); q += p.length; }
    return { bytes: out, removed };
  }

  // Reescreve a página OpusTags com um comentário ZFID único.
  // Retorna Uint8Array novo, ou null se a estrutura não for a
  // esperada (aí o chamador manda os bytes originais).
  function uniquifyOggOpus(u8) {
    const head = readOggPage(u8, 0);
    if (!head) return null;
    const tags = readOggPage(u8, head.end);
    if (!tags || !ascii(u8, tags.bodyStart, 'OpusTags')) return null;
    // OpusTags precisa caber inteiro nesta página (caso normal).
    // Tags gigantes (capa de álbum etc.) atravessam páginas — não mexe.
    if (tags.lastLacing === 255) return null;

    const body = u8.subarray(tags.bodyStart, tags.end);
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let p = 8;
    const vendorLen = dv.getUint32(p, true); p += 4;
    if (p + vendorLen + 4 > body.length) return null;
    const vendor = body.subarray(p, p + vendorLen); p += vendorLen;
    const count = dv.getUint32(p, true); p += 4;
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const comments = [];
    for (let i = 0; i < count; i++) {
      if (p + 4 > body.length) return null;
      const len = dv.getUint32(p, true); p += 4;
      if (p + len > body.length) return null;
      const c = body.subarray(p, p + len); p += len;
      if (!dec.decode(c).toUpperCase().startsWith('ZFID=')) comments.push(c);
    }
    const rnd = crypto.getRandomValues(new Uint8Array(8));
    const id = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
    comments.push(enc.encode(`ZFID=${id}`));

    let newLen = 8 + 4 + vendor.length + 4;
    for (const c of comments) newLen += 4 + c.length;
    const lacingCount = Math.floor(newLen / 255) + 1;
    if (lacingCount > 255) return null;

    const newBody = new Uint8Array(newLen);
    const nb = new DataView(newBody.buffer);
    newBody.set(body.subarray(0, 8), 0);
    let q = 8;
    nb.setUint32(q, vendor.length, true); q += 4;
    newBody.set(vendor, q); q += vendor.length;
    nb.setUint32(q, comments.length, true); q += 4;
    for (const c of comments) {
      nb.setUint32(q, c.length, true); q += 4;
      newBody.set(c, q); q += c.length;
    }

    const page = new Uint8Array(27 + lacingCount + newLen);
    page.set(u8.subarray(tags.off, tags.off + 26), 0);
    page[26] = lacingCount;
    for (let i = 0; i < lacingCount - 1; i++) page[27 + i] = 255;
    page[27 + lacingCount - 1] = newLen % 255;
    page.set(newBody, 27 + lacingCount);
    writeOggCrc(page);

    const out = new Uint8Array(tags.off + page.length + (u8.length - tags.end));
    out.set(u8.subarray(0, tags.off), 0);
    out.set(page, tags.off);
    out.set(u8.subarray(tags.end), tags.off + page.length);
    return out;
  }

  // Espera o WA confirmar que a mensagem saiu (upload terminado +
  // servidor recebeu). WA-JS devolve sendMsgResult como Promise
  // mesmo com waitForAck:false. Timeout curto pra não estourar os
  // 60s do callInjectedApi — se passar disso, a mensagem já está na
  // fila do WA e vai sair sozinha; não reportamos erro pra não
  // gerar reenvio duplicado.
  async function waitSendResult(result, timeoutMs = 40_000) {
    const pending = result?.sendMsgResult;
    if (!pending || typeof pending.then !== 'function') return { status: 'unknown' };
    let timer;
    try {
      const r = await Promise.race([
        pending,
        new Promise((resolve) => { timer = setTimeout(() => resolve('__timeout__'), timeoutMs); }),
      ]);
      if (r === '__timeout__') return { status: 'pending' };
      // Formato do resolve varia entre versões do WA; só trata como
      // falha quando o WA devolve explicitamente um código ERROR_*.
      const code = r?.messageSendResult ?? (typeof r === 'string' ? r : undefined);
      return { status: code && /ERROR/i.test(String(code)) ? 'failed' : 'ok', code };
    } catch (e) {
      return { status: 'failed', code: e?.message || String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  // ----------------------------------------------------------
  // sendFile — via WPP.chat.sendFileMessage
  // ----------------------------------------------------------
  async function sendFile(jid, blob, { type = 'auto', caption = '', filename, isPtt = false } = {}) {
    if (!jid) throw new Error('jid obrigatório');
    if (!(blob instanceof Blob)) throw new Error('blob inválido');
    if (!window.WPP || !window.WPP.isReady) {
      throw new Error('WPP não está pronto');
    }

    const targetJid = normalizeJid(jid);
    const fname = filename || blob.name || `zapfire-${Date.now()}`;

    // PTT exige mimetype EXATO 'audio/ogg; codecs=opus' senão Android
    // rejeita o codec. Áudios importados do ZapVoice (backup 3.0.0)
    // vêm como 'audio/ogg' puro — por isso o File é sempre recriado.
    const pttMime = 'audio/ogg; codecs=opus';

    // ---- PTT ----
    if (isPtt) {
      const u8 = new Uint8Array(await blob.arrayBuffer());
      const sniff = sniffAudio(u8);

      if (sniff.kind !== 'ogg-opus') {
        // Não é Opus: mandar como PTT garante "áudio não disponível".
        // Vai como anexo de áudio com o mimetype real.
        console.warn(LOG, `PTT recebeu bytes ${sniff.kind} (type declarado: ${blob.type}) — enviando como áudio comum. Rode "Atualizar biblioteca" no gerenciador pra converter.`);
        const mime = sniff.mime || blob.type || 'audio/mpeg';
        const file = new File([u8], fname, { type: mime });
        const result = await window.WPP.chat.sendFileMessage(targetJid, file, {
          type: 'audio',
          isPtt: false,
          filename: fname,
          mimetype: mime,
          waitForAck: false,
        });
        const sent = await waitSendResult(result);
        if (sent.status === 'failed') {
          return { ok: false, error: `WhatsApp recusou o áudio (${sent.code})`, id: result?.id };
        }
        return { ok: true, id: result?.id, ack: result?.ack, via: 'sendFileMessage-audio-fallback', degraded: `not-opus:${sniff.kind}`, sendStatus: sent.status };
      }

      const clean = stripEmptyOggPackets(u8);
      const unique = uniquifyOggOpus(clean.bytes);
      if (!unique) console.warn(LOG, 'OpusTags fora do padrão — enviando sem ZFID (pode reaproveitar upload antigo)');
      const fileForSend = new File([unique || clean.bytes], fname.replace(/\.[^.]*$/, '') + '.ogg', { type: pttMime });

      console.log(LOG, 'sendFile PTT —', {
        declaredType: blob.type,
        size: fileForSend.size,
        emptyPacketsRemoved: clean.removed,
        uniquified: !!unique,
      });

      const result = await window.WPP.chat.sendFileMessage(targetJid, fileForSend, {
        type: 'audio',
        isPtt: true,
        filename: fileForSend.name,
        mimetype: pttMime,
        // true = WA-JS decodifica e preenche duration + waveform
        // (precomputedFields). Array aqui é ignorado pelo WA-JS 4.x.
        waveform: true,
        // Não bloqueia no ack dentro do WA-JS; esperamos nós mesmos
        // com timeout em waitSendResult. Isso também garante que o
        // próximo passo do funil (ex: texto) só sai DEPOIS do áudio
        // terminar o upload — antes o texto chegava antes do áudio.
        waitForAck: false,
      });
      const sent = await waitSendResult(result);
      console.log(LOG, 'PTT', result?.id, 'status:', sent.status, sent.code ?? '');
      if (sent.status === 'failed') {
        return { ok: false, error: `WhatsApp recusou o áudio (${sent.code})`, id: result?.id };
      }
      return { ok: true, id: result?.id, ack: result?.ack, via: 'sendFileMessage-ptt', uniquified: !!unique, emptyPacketsRemoved: clean.removed, sendStatus: sent.status };
    }

    // ---- Mídia comum (image/video/document/audio) ----
    const opts = {
      type,
      filename: fname,
      caption,
      mimetype: blob.type || undefined,
    };

    const result = await window.WPP.chat.sendFileMessage(targetJid, blob, opts);
    return { ok: true, id: result?.id?._serialized, ack: result?.ack };
  }

  // ----------------------------------------------------------
  // Bootstrap
  // ----------------------------------------------------------
  (async () => {
    console.log(LOG, 'aguardando window.require...');
    if (!(await waitForRequire())) {
      console.error(LOG, 'require nunca ficou disponível');
      return;
    }

    console.log(LOG, 'carregando módulos nativos...');
    const nativeModules = await loadNativeModules();
    const missing = REQUIRED_NATIVE_MODULES.filter((n) => !nativeModules[n]);
    if (missing.length) {
      console.error(LOG, 'módulos nativos faltando:', missing);
    } else {
      console.log(LOG, 'módulos nativos OK');
    }

    console.log(LOG, 'aguardando WPP (WA-JS) ficar pronto...');
    const wppOk = await waitForWPP();
    if (wppOk) {
      console.log(LOG, 'WPP ready ✓');
    } else {
      console.error(LOG, 'WPP NÃO ficou pronto (verifique se wppconnect-wa-js.js está em extension/vendor/)');
    }

    // Expõe API pro console (smoke test)
    window.__zf = {
      ready: !missing.length,
      wppReady: wppOk,
      sendText: (jid, text) => sendText(jid, text, nativeModules),
      sendFile: (jid, blob, opts) => sendFile(jid, blob, opts),
    };
    console.log(LOG, 'API pronta:', Object.keys(window.__zf));

    // ------------------------------------------------------
    // getActiveChatId — identidade do chat aberto via WPP
    // ------------------------------------------------------
    function getActiveChatId() {
      try {
        // WPP.chat.getActiveChat() retorna o chat atualmente aberto
        const active = window.WPP?.chat?.getActiveChat?.();
        if (active) {
          return {
            ok: true,
            target: {
              jid: active.id?._serialized || null,
              name: active.name || active.formattedTitle || active.contact?.name || null,
              phone: active.id?.user || null,
            },
          };
        }
        // Fallback: ChatStore do WPP
        const store = window.WPP?.whatsapp?.ChatStore;
        if (store) {
          const list = store.getModelsArray?.() || [];
          const recent = list.find((c) => c.active);
          if (recent) {
            return {
              ok: true,
              target: {
                jid: recent.id?._serialized || null,
                name: recent.name || recent.formattedTitle || null,
                phone: recent.id?.user || null,
              },
            };
          }
        }
      } catch (e) {
        return { ok: false, error: e.message };
      }
      return { ok: false, error: 'nenhuma conversa ativa detectada' };
    }

    // ------------------------------------------------------
    // Bridge postMessage
    // ------------------------------------------------------
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || msg.__zf_source !== 'content') return;
      if (!msg.type || !msg.type.startsWith('ZF_API_')) return;

      let result;
      try {
        switch (msg.type) {
          case 'ZF_API_PING':
            result = { ok: true, wppReady: !!(window.WPP && window.WPP.isReady) };
            break;
          case 'ZF_API_GET_ACTIVE_CHAT':
            result = getActiveChatId();
            break;
          // Pega o JID do próprio user (pra "enviar pra mim mesmo").
          // Necessário porque contas em LID (@lid) não casam com o
          // formato construído `${phone}@c.us` — chat não encontrado.
          // WPP.whatsapp.UserPrefs.getMaybeMeUser() retorna o Wid
          // canônico (LID ou PN, conforme a conta).
          case 'ZF_API_GET_SELF_JID': {
            try {
              const prefs = window.WPP?.whatsapp?.UserPrefs;
              const me = prefs?.getMaybeMeUser?.()
                      || prefs?.getMaybeMePnUser?.()
                      || prefs?.getMe?.();
              const jid = me?._serialized || me?.id?._serialized || null;
              if (jid) {
                result = { ok: true, jid };
              } else {
                result = { ok: false, error: 'WPP UserPrefs não retornou self user' };
              }
            } catch (e) {
              result = { ok: false, error: e.message || String(e) };
            }
            break;
          }
          case 'ZF_API_SEND_TEXT':
            result = await sendText(msg.jid, msg.text, nativeModules);
            break;
          case 'ZF_API_SEND_FILE':
            result = await sendFile(msg.jid, msg.blob, {
              type: msg.fileType || 'auto',
              caption: msg.caption,
              filename: msg.filename,
              isPtt: !!msg.isPtt,
            });
            break;
          // Sprint 5 — abre conversa pelo JID (usado pelo botão
          // "Abrir conversa" da tab Relatórios no manager). Usa
          // WPP.chat.openChatBottom que rola até a última mensagem.
          // Presença "digitando..." / "gravando áudio..." pro contato
          // ver durante o envio de funil. Texto = composing, áudio =
          // recording. Duração em ms; WPP limpa sozinho ao fim.
          case 'ZF_API_SET_PRESENCE':
            try {
              if (!window.WPP?.chat) {
                result = { ok: false, error: 'WPP indisponível' };
              } else {
                const jid = msg.jid;
                const dur = Math.max(500, Math.min(60000, msg.durationMs || 2000));
                const kind = msg.kind; // 'typing' | 'recording' | 'paused'
                if (kind === 'typing' && typeof window.WPP.chat.markIsComposing === 'function') {
                  await window.WPP.chat.markIsComposing(jid, dur);
                  result = { ok: true };
                } else if (kind === 'recording' && typeof window.WPP.chat.markIsRecording === 'function') {
                  await window.WPP.chat.markIsRecording(jid, dur);
                  result = { ok: true };
                } else if (kind === 'paused' && typeof window.WPP.chat.markIsPaused === 'function') {
                  await window.WPP.chat.markIsPaused(jid);
                  result = { ok: true };
                } else {
                  result = { ok: false, error: 'kind inválido ou função WPP ausente: ' + kind };
                }
              }
            } catch (e) {
              result = { ok: false, error: e.message || String(e) };
            }
            break;

          case 'ZF_API_OPEN_CHAT':
            try {
              if (!window.WPP?.chat) {
                result = { ok: false, error: 'WPP indisponível' };
              } else if (typeof window.WPP.chat.openChatBottom === 'function') {
                await window.WPP.chat.openChatBottom(msg.jid);
                result = { ok: true };
              } else if (typeof window.WPP.chat.openChat === 'function') {
                // Fallback se WA-JS futuro renomear
                await window.WPP.chat.openChat(msg.jid);
                result = { ok: true };
              } else {
                result = { ok: false, error: 'WPP.chat.openChatBottom não existe nessa versão' };
              }
            } catch (e) {
              result = { ok: false, error: e.message || String(e) };
            }
            break;
          default:
            result = { ok: false, error: 'tipo desconhecido: ' + msg.type };
        }
      } catch (e) {
        result = { ok: false, error: e.message || String(e) };
      }

      window.postMessage({
        __zf_source: 'injected',
        type: 'ZF_API_RESPONSE',
        requestId: msg.requestId,
        result,
      }, '*');
    });

    console.log(LOG, 'bridge postMessage instalado');
  })();
})();
