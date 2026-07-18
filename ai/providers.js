// LLM provider abstraction for the AI-general battle. Most hosted LLMs speak the
// OpenAI /chat/completions shape, so one fetch path covers Groq, OpenAI, Pioneer,
// and friends — differing only by base URL, model, and API-key env var. A built-in
// `mock` provider needs no network so the turn loop can be tested offline.
//
// Keys come from the environment (never hard-code them):
//   GROQ_API_KEY, OPENAI_API_KEY, PIONEER_API_KEY  (+ optional *_BASE_URL / *_MODEL)

const PRESETS = {
  groq: {
    baseURL: () => process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    model: () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    key: () => process.env.GROQ_API_KEY,
  },
  openai: {
    baseURL: () => process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: () => process.env.OPENAI_MODEL || 'gpt-4o-mini',
    key: () => process.env.OPENAI_API_KEY,
  },
  // Pioneer (https://alpha.pioneers.dev). Assumed OpenAI-compatible; override the
  // base/model via env if their API differs.
  pioneer: {
    baseURL: () => process.env.PIONEER_BASE_URL || 'https://alpha.pioneers.dev/v1',
    model: () => process.env.PIONEER_MODEL || 'default',
    key: () => process.env.PIONEER_API_KEY,
  },
};

export function resolveProvider(name) {
  if (!name || name === 'none') return null;
  if (name === 'mock') return { name: 'mock', mock: true, model: 'mock' };
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown AI provider '${name}' (use: ${Object.keys(PRESETS).join(', ')}, mock)`);
  const key = p.key();
  if (!key) throw new Error(`${name} selected but ${name.toUpperCase()}_API_KEY is not set`);
  return { name, baseURL: p.baseURL(), model: p.model(), key };
}

// Send a chat and return the assistant's text. `mock` is handled by the caller.
export async function chat(cfg, messages, { temperature = 0.4, maxTokens = 700 } = {}) {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`${cfg.name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
