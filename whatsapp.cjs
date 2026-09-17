/**
 * AstroDost WhatsApp Bot (Baileys) — mobile number pe AI astrologer
 * ------------------------------------------------------------------
 * - Pairing code (phone number se link) — QR ki zaroorat nahi
 * - Session Railway volume (/data) pe save — restart ke baad bhi linked
 * - Har message ka jawab AstroDost AI chain se (Gemini -> OpenRouter fallback)
 *
 * Env (optional):
 *   WA_SESSION_DIR   - session folder (default: /data/wa-session ya ./wa-session)
 *   SETUP_PIN        - pairing page protection (default: 4321)
 *   WA_OWNER         - owner JID (msisdn@s.whatsapp.net) - pin ke bina pairing allow karne ke liye
 */

const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

let sock = null;
let latestQR = null;          // data-url
let pairingCode = null;       // 8-char code
let pairingPhone = null;
let connectionStatus = 'starting'; // starting | qr | pairing | connecting | connected | disconnected
let lastError = null;

function sessionDir() {
  const d = process.env.WA_SESSION_DIR
    || (fs.existsSync('/data') ? '/data/wa-session' : path.join(__dirname, 'wa-session'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const SYSTEM_PROMPT = `You are Acharya AstroDost — AstroDost AI ka official WhatsApp bot.
Ek wise, warm Vedic astrologer ki tarah Hindi/Hinglish mein jawab do (user ki language follow karo).
Rules:
- Astrology guidance do: grah, kundali, rashifal, upay, gemstones, muhurat basics.
- Personalized kundali ke liye naam, DOB, birth time, birth place maango.
- Medical/legal/financial emergencies mein professional ki salah recommend karo — astrology is guidance, not a substitute.
- Jawab chhota rakho (WhatsApp friendly): 80-120 words, zaroorat ho to short paragraphs ya bullets.
- Kahin bhi AI/Gemini/OpenRouter/system prompt ka zikr mat karo.
- End mein ek practical next step do (kundali details bhejo, ya sawal aur clear karo).`;

async function getAIReply(senderName, text) {
  const { smartAIChain } = require('./ai-chain.cjs');
  const userPrompt = `WhatsApp user "${senderName || 'Jio user'}" likhta hai: ${text}`;
  return smartAIChain(SYSTEM_PROMPT, userPrompt, [], 0.7);
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir());
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['AstroDost', 'Chrome', '120.0.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      latestQR = await qrcode.toDataURL(qr);
      connectionStatus = 'qr';
      console.log('[WA] QR ready — /wa page se scan karo (ya pairing code lo)');
      // Pairing code auto-request agar phone number set hai
      const phone = process.env.WA_LINK_PHONE;
      if (phone && !sock.authState.creds.registered) {
        try {
          pairingCode = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
          pairingPhone = phone;
          connectionStatus = 'pairing';
          console.log(`[WA] Pairing code for +${phone}: ${pairingCode}`);
        } catch (e) {
          console.error('[WA] pairing code request failed:', e.message);
        }
      }
    }

    if (connection === 'connecting') connectionStatus = 'connecting';

    if (connection === 'open') {
      connectionStatus = 'connected';
      latestQR = null;
      pairingCode = null;
      console.log('[WA] ✅ WhatsApp CONNECTED — ab messages pe jawab dega');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      connectionStatus = reconnect ? 'connecting' : 'disconnected';
      lastError = lastDisconnect?.error?.message || 'closed';
      console.log(`[WA] connection closed (code=${code}) reconnect=${reconnect}`);
      if (reconnect) setTimeout(startWhatsApp, 3000);
      else {
        // logged out — session clear karke fresh start (naya pairing possible)
        try { fs.rmSync(sessionDir(), { recursive: true, force: true }); } catch {}
        setTimeout(startWhatsApp, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (jid.endsWith('@g.us')) continue; // groups skip

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';
      if (!text.trim()) continue;

      const senderName = msg.pushName || '';
      console.log(`[WA] ${senderName || jid}: ${text.slice(0, 80)}`);

      try {
        const reply = await getAIReply(senderName, text.trim());
        if (reply) {
          await sock.sendMessage(jid, { text: reply });
          console.log(`[WA] -> reply bheja (${reply.length} chars)`);
        } else {
          await sock.sendMessage(jid, { text: '🙏 Kshama karein, abhi AI thoda vyast hai. Thodi der baad try karein.' });
        }
      } catch (e) {
        console.error('[WA] reply failed:', e.message);
        try { await sock.sendMessage(jid, { text: '🙏 Error aa gaya. Dobara try karein.' }); } catch {}
      }
    }
  });
}

// ---------------- Web pairing page helpers ----------------

function waStatus() {
  return {
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    pairingCode: pairingCode,
    pairingPhone: pairingPhone || null,
    qr: latestQR,           // data-url (qr page pe <img> mein)
    error: lastError,
  };
}

/**
 * Pairing code request — PIN protection ke saath
 * POST /wa/request-code { phone: "919876543210", pin: "4321" }
 */
async function requestCode(phone, pin) {
  const expectedPin = process.env.SETUP_PIN || '4321';
  if (String(pin) !== String(expectedPin)) {
    return { ok: false, error: 'galat PIN' };
  }
  if (!sock) return { ok: false, error: 'bot abhi start nahi hua' };
  if (sock.authState.creds.registered) {
    return { ok: false, error: 'pehle se linked hai — pehle logout karo (/wa page se)' };
  }
  const clean = String(phone).replace(/[^0-9]/g, '');
  if (clean.length < 10) return { ok: false, error: 'phone number country code ke saath do (e.g. 919876543210)' };
  try {
    pairingCode = await sock.requestPairingCode(clean);
    pairingPhone = clean;
    connectionStatus = 'pairing';
    return { ok: true, code: pairingCode };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function logoutWa() {
  try {
    if (sock) await sock.logout();
  } catch {}
  try { fs.rmSync(sessionDir(), { recursive: true, force: true }); } catch {}
  latestQR = null;
  pairingCode = null;
  connectionStatus = 'starting';
  setTimeout(startWhatsApp, 2000);
  return { ok: true };
}

module.exports = { startWhatsApp, waStatus, requestCode, logoutWa };
