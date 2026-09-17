# AstroDost AI Proxy (astrokundali)

Lightweight Express proxy for the AstroDost AI app — deployed on Railway.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ status, app, gemini, openrouter, time }` |
| POST | `/api/gemini/chat` | `{ message, history?, temperature? }` | `{ reply }` |
| POST | `/api/gemini/kundali-analysis` | `{ userPrompt }` | `{ analysis }` |
| POST | `/api/gemini/matchmaking` | `{ userPrompt }` | `{ report }` |
| POST | `/api/gemini/prashna` | `{ userPrompt }` | `{ answer }` |

## AI provider chain (server-side, keys safe)

1. **Gemini** (`gemini-2.5-flash` → `2.0-flash` → `2.0-flash-lite` → `1.5-flash`) — needs `GEMINI_API_KEY`
2. **OpenRouter free models** (ling, gemma, glm, nemotron, inkling) — needs `OPENROUTER_API_KEY`

First provider that succeeds wins. If all fail → `503` and the app falls back to its local Vedic engine.

## Railway setup

Environment variables (Project → Service → Variables):

- `OPENROUTER_API_KEY` — required (recommended)
- `GEMINI_API_KEY` — optional
- `PORT` — set automatically by Railway

## Local run

```
npm install
npm start
```
