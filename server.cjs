/**
 * AstroDost AI Proxy Server — Railway Deployment
 * -----------------------------------------------
 * Aapke original server.ts ka lightweight version:
 * - /api/gemini/* endpoints (app ke custom-server client ke liye)
 * - Gemini direct + OpenRouter fallback chain (SERVER-side, keys safe)
 * - Static frontend bhi serve karta hai (public/ available ho to)
 *
 * Railway env vars (Dashboard > Variables):
 *   GEMINI_API_KEY       (optional)
 *   OPENROUTER_API_KEY   (recommended)
 *   PORT                 (Railway khud set karta hai)
 */

const express = require('express');
const path = require('path');

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

/** Universal fallback chain — kisi bhi /api/gemini/* endpoint ke liye */
async function smartAIChain(systemPrompt, userPrompt, history, temperature) {
  const attempts = [];
  const geminiKey = process.env.GEMINI_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;

  if (geminiKey) {
    for (const model of GEMINI_MODELS) {
      attempts.push(() => callGemini(model, systemPrompt, userPrompt, history, temperature, geminiKey));
    }
  }
  if (orKey) {
    for (const model of OPENROUTER_CURATED) {
      attempts.push(() => callOpenRouter(model, systemPrompt, userPrompt, history, temperature, orKey));
    }
  }

  for (const attempt of attempts) {
    try {
      const text = await withTimeout(attempt(), 26000);
      return text;
    } catch (err) {
      console.warn('[chain] provider failed:', err.message);
    }
  }
  return null;
}

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

// Static frontend (agar public/ folder Railway pe upload hua hai)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) res.status(200).send('AstroDost AI Proxy Server running. API: /api/gemini/chat');
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ AstroDost Proxy on :${PORT}`);
  console.log(`   Gemini: ${process.env.GEMINI_API_KEY ? 'YES' : 'no'} | OpenRouter: ${process.env.OPENROUTER_API_KEY ? 'YES' : 'no'}`);
});
