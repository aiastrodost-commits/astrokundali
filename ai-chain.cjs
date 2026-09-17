/**
 * AstroDost AI chain — Gemini + OpenRouter fallback (server-side keys)
 * server.cjs aur whatsapp.cjs dono use karte hain.
 */

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

module.exports = { smartAIChain, GEMINI_MODELS, OPENROUTER_CURATED };
