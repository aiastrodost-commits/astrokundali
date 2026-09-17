/**
 * AstroDost AI Proxy Server — Railway Deployment
 * -----------------------------------------------
 * - /api/gemini/* endpoints (app ke custom-server client ke liye)
 * - Gemini direct + OpenRouter fallback chain (SERVER-side, keys safe)
 * - WhatsApp AI bot (Baileys) — pairing: /wa page (WA_BOT=off se disable)
 *
 * Railway env vars (Dashboard > Variables):
 *   GEMINI_API_KEY       (optional)
 *   OPENROUTER_API_KEY   (recommended)
 *   SETUP_PIN            (WhatsApp pairing page ka PIN, default 4321)
 *   WA_BOT=off           (WhatsApp bot band karne ke liye)
 *   PORT                 (Railway khud set karta hai)
 */

const express = require('express');
const path = require('path');
const WA_ENABLED = process.env.WA_BOT !== 'off';
const { startWhatsApp, waStatus, requestCode, logoutWa } = WA_ENABLED ? require('./whatsapp.cjs') : {};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// CORS — phone APK se direct calls ke liye
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Providers (server-side fallback chain)
// ---------------------------------------------------------------------------

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

const OPENROUTER_CURATED = [
  'inclusionai/ling-3.0-flash-vl:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'z-ai/glm-5.2:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  // Extra fallbacks (verified live on OpenRouter)
  'inclusionai/ling-3.0-flash-sante:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
];

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

async function callGemini(model, systemPrompt, userPrompt, history, temperature, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const contents = [
      ...(history || []).slice(-6).map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text || m.content || '' }],
      })),
      { role: 'user', parts: [{ text: userPrompt }] },
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: temperature ?? 0.7 },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text.trim()) throw new Error('empty');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenRouter(model, systemPrompt, userPrompt, history, temperature, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-6).map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text || m.content || '',
      })),
      { role: 'user', content: userPrompt },
    ];
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://astrodost.app',
        'X-Title': 'AstroDost AI',
      },
      signal: controller.signal,
      body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7 }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OR ${model} HTTP ${res.status}: ${body.slice(0, 100)}`);
    }
    const data = await res.json();
    if (data?.error?.message) throw new Error(data.error.message);
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text.trim()) throw new Error('empty');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Universal fallback chain — ab ai-chain.cjs module se (WhatsApp bot bhi use karta hai) */
const { smartAIChain } = require('./ai-chain.cjs');

// ---------------------------------------------------------------------------
// Endpoints (app ka custom-server client ye shapes expect karta hai)
// ---------------------------------------------------------------------------

function handler(responseField) {
  return async (req, res) => {
    const { message, systemInstruction, userPrompt, prompt, history, temperature } = req.body || {};
    const sys = systemInstruction || 'You are Acharya AstroDost, a wise Vedic astrologer.';
    const user = userPrompt || prompt || message || '';
    if (!user.trim()) return res.status(400).json({ error: 'message/userPrompt required' });

    const text = await smartAIChain(sys, user, history, temperature);
    if (text) return res.json({ [responseField]: text });
    // Server bhi fail → client apna local Vedic engine use karega
    return res.status(503).json({ error: 'All AI providers failed' });
  };
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'AstroDost AI Proxy',
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    time: new Date().toISOString(),
  });
});

app.post('/api/gemini/chat', handler('reply'));
app.post('/api/gemini/kundali-analysis', handler('analysis'));
app.post('/api/gemini/matchmaking', handler('report'));
app.post('/api/gemini/prashna', handler('answer'));

// ---------------------------------------------------------------------------
// WhatsApp bot pairing page + API
// ---------------------------------------------------------------------------

app.get('/wa/status', (req, res) => {
  if (!WA_ENABLED) return res.json({ status: 'disabled', connected: false });
  const s = waStatus();
  res.json({ ...s, qr: undefined, hasQR: Boolean(s.qr) });
});

app.get('/wa/qr', (req, res) => {
  if (!WA_ENABLED) return res.status(404).send('WhatsApp bot disabled');
  const s = waStatus();
  if (!s.qr) return res.status(404).json({ error: 'no QR abhi' });
  res.json({ qr: s.qr });
});

app.post('/wa/request-code', async (req, res) => {
  if (!WA_ENABLED) return res.status(404).json({ error: 'WhatsApp bot disabled' });
  const { phone, pin } = req.body || {};
  const r = await requestCode(phone, pin);
  res.json(r);
});

app.post('/wa/logout', async (req, res) => {
  if (!WA_ENABLED) return res.status(404).json({ error: 'WhatsApp bot disabled' });
  res.json(await logoutWa());
});

// Pairing web page (mobile-friendly)
app.get('/wa', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstroDost WhatsApp Setup</title>
<style>
 body{font-family:system-ui;background:#0f0e17;color:#fffffe;max-width:480px;margin:0 auto;padding:24px}
 h1{font-size:1.4rem} .card{background:#1a1926;border-radius:12px;padding:20px;margin:12px 0}
 input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #444;background:#242335;color:#fff;font-size:1rem;margin:6px 0}
 button{width:100%;padding:12px;border:0;border-radius:8px;background:#7f5af0;color:#fff;font-size:1rem;font-weight:600;cursor:pointer;margin-top:8px}
 .ok{color:#2cb67d}.bad{color:#ff5470}.muted{color:#8b8ca7;font-size:.85rem}
 img{width:100%;max-width:280px;border-radius:8px;background:#fff;padding:8px}
 #code{font-size:2rem;letter-spacing:.3rem;text-align:center;color:#2cb67d;font-weight:700;margin:10px 0}
</style></head><body>
<h1>🪐 AstroDost WhatsApp Bot</h1>
<div class="card">
 <div>Status: <b id="st">checking…</b></div>
 <div id="pairbox" style="display:none">
   <div id="code"></div>
   <div class="muted">WhatsApp → Settings → Linked devices → Link a device → “Link with phone number instead” → ye code daalo</div>
 </div>
 <div id="qrbox" style="display:none"><img id="qr" alt="QR"><div class="muted">Ya QR scan karo: WhatsApp → Linked devices → Link a device</div></div>
</div>
<div class="card">
 <h3>📲 Naya number link karo</h3>
 <input id="phone" placeholder="WhatsApp number (country code ke saath) — e.g. 919876543210">
 <input id="pin" placeholder="Setup PIN (Railway SETUP_PIN variable, default 4321)">
 <button onclick="link()">Pairing Code Lo</button>
 <div id="msg" class="muted"></div>
</div>
<div class="card"><button style="background:#ff5470" onclick="unlink()">Logout / Unlink</button></div>
<script>
async function refresh(){
 const s=await (await fetch('/wa/status')).json();
 document.getElementById('st').textContent=s.status+(s.pairingCode?(' — code: '+s.pairingCode):'');
 document.getElementById('st').className=s.connected?'ok':(s.status==='qr'||s.status==='pairing'?'':'bad');
 if(s.pairingCode){document.getElementById('pairbox').style.display='block';document.getElementById('code').textContent=s.pairingCode;}
 if(s.hasQR){try{const q=await(await fetch('/wa/qr')).json();document.getElementById('qrbox').style.display='block';document.getElementById('qr').src=q.qr;}catch(e){}}
}
async function link(){
 const p=document.getElementById('phone').value.trim(),pin=document.getElementById('pin').value.trim();
 const r=await(await fetch('/wa/request-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p,pin})})).json();
 document.getElementById('msg').textContent=r.ok?('✅ Code mila: '+r.code+' — 60 second mein WhatsApp mein daalo'):('❌ '+(r.error||'fail'));
 document.getElementById('msg').className=r.ok?'ok':'bad'; setTimeout(refresh,1500);
}
async function unlink(){ if(confirm('Bot unlink karein?')){await fetch('/wa/logout',{method:'POST'});setTimeout(refresh,1500);} }
refresh(); setInterval(refresh,5000);
</script></body></html>`);
});

// Static frontend (agar public/ folder Railway pe upload hua hai)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/wa')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) res.status(200).send('AstroDost AI Proxy Server running. API: /api/gemini/chat | WhatsApp setup: /wa');
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ AstroDost Proxy on :${PORT}`);
  console.log(`   Gemini: ${process.env.GEMINI_API_KEY ? 'YES' : 'no'} | OpenRouter: ${process.env.OPENROUTER_API_KEY ? 'YES' : 'no'}`);
  console.log(`   WhatsApp bot: ${WA_ENABLED ? 'ON (setup: /wa)' : 'off'}`);
  if (WA_ENABLED) {
    startWhatsApp().catch((e) => console.error('[WA] start failed:', e.message));
  }
});
