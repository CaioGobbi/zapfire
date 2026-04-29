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
  // Waveform — pré-calcula amplitudes pra PTT ter visual igual
  // ao do WA nativo (gravado pelo microfone dentro do app).
  // WA usa array de 64 bytes, cada um 0-100% da amplitude max.
  // ----------------------------------------------------------
  async function computeWaveform(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const arrayBuf = await blob.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
      const samples = audioBuf.getChannelData(0);

      // WA usa 64 bytes, cada byte = RMS do bucket escalado pra 0-100
      const BARS = 64;
      const step = Math.max(1, Math.floor(samples.length / BARS));
      const waveform = new Uint8Array(BARS);

      const rmsBuckets = new Float32Array(BARS);
      let maxRms = 0;
      for (let i = 0; i < BARS; i++) {
        const start = i * step;
        const end = Math.min(start + step, samples.length);
        let sumSq = 0;
        for (let j = start; j < end; j++) {
          sumSq += samples[j] * samples[j];
        }
        const rms = Math.sqrt(sumSq / Math.max(1, end - start));
        rmsBuckets[i] = rms;
        if (rms > maxRms) maxRms = rms;
      }
      // Normaliza pelo pico RMS (não pelo pico de amostra)
      const norm = maxRms > 0 ? 100 / maxRms : 1;
      for (let i = 0; i < BARS; i++) {
        waveform[i] = Math.min(100, Math.round(rmsBuckets[i] * norm));
      }

      try { ctx.close(); } catch (_) {}
      return waveform;
    } catch (e) {
      console.warn(LOG, 'waveform compute failed:', e.message);
      return null;
    }
  }

  // ----------------------------------------------------------
  // sendFile — via WPP.chat.sendFileMessage / sendVoiceMessage
  // ----------------------------------------------------------
  async function sendFile(jid, blob, { type = 'auto', caption = '', filename, isPtt = false } = {}) {
    if (!jid) throw new Error('jid obrigatório');
    if (!(blob instanceof Blob)) throw new Error('blob inválido');
    if (!window.WPP || !window.WPP.isReady) {
      throw new Error('WPP não está pronto');
    }

    const targetJid = normalizeJid(jid);
    const fname = filename || blob.name || `zapfire-${Date.now()}`;

    // Normaliza pra File — o blob do IndexedDB vem como Blob puro
    // (sem .name), WPP pode tratar diferente de um File legit.
    const fileForSend = blob instanceof File
      ? blob
      : new File([blob], fname, { type: blob.type || 'audio/mpeg' });

    // ---- PTT: usa sendVoiceMessage (helper especializado) + waveform ----
    if (isPtt) {
      console.log(LOG, 'sendFile PTT — blob:', {
        type: blob.type,
        size: blob.size,
        isFile: blob instanceof File,
        fileName: fileForSend.name,
      });
      const waveform = await computeWaveform(blob);
      console.log(LOG, 'waveform:', waveform
        ? `Uint8Array [${Array.from(waveform).slice(0, 8).join(',')}...] (${waveform.length} bytes)`
        : 'NULL (decode falhou)');

      // sendVoiceMessage é o caminho preferido pra PTT
      if (typeof window.WPP.chat.sendVoiceMessage === 'function') {
        try {
          const result = await window.WPP.chat.sendVoiceMessage(targetJid, fileForSend, {
            waveform: waveform || undefined,
          });
          return { ok: true, id: result?.id?._serialized, ack: result?.ack, via: 'sendVoiceMessage', hadWaveform: !!waveform };
        } catch (e) {
          console.warn(LOG, 'sendVoiceMessage falhou, caindo em sendFileMessage:', e.message);
        }
      }

      // Fallback: sendFileMessage com isPtt + waveform
      const result = await window.WPP.chat.sendFileMessage(targetJid, fileForSend, {
        type: 'audio',
        isPtt: true,
        filename: fname,
        mimetype: blob.type || 'audio/mpeg',
        waveform: waveform || undefined,
      });
      return { ok: true, id: result?.id?._serialized, ack: result?.ack, via: 'sendFileMessage-ptt', hadWaveform: !!waveform };
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
