// List the chat models your API key can actually use, for `make models`.
//   bun ai/models.js [provider]     (provider: groq | openai | pioneer, default groq)
import { resolveProvider } from './providers.js';

const name = process.argv[2] || 'groq';
let p;
try { p = resolveProvider(name); } catch (e) { console.error(e.message); process.exit(1); }

try {
  const res = await fetch(`${p.baseURL}/models`, { headers: { Authorization: `Bearer ${p.key}` } });
  if (!res.ok) { console.error(`${name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1); }
  const data = await res.json();
  const ids = (data.data || []).map((m) => m.id).sort();
  console.log(`# ${name} models (use as ${name}:<id>):`);
  for (const id of ids) console.log(`  ${name}:${id}`);
} catch (e) {
  console.error(`could not reach ${name}: ${e.message}`);
  process.exit(1);
}
