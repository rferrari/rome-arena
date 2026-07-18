// Phase 1 headless smoke test: prove the WASM physics loads in Bun and that
// gravity + contact work — drop a cube from y=8, step 150x at 1/60, assert it
// falls and settles on the ground at y ~= 0.5 (its half-extent).  `bun physics/smoke.js`
import { loadArena } from './arena_loader.js';

const a = await loadArena();
a.createWorld();
a.dropTestBox(8);

console.log(`start y=${a.getTestY().toFixed(3)}`);
for (let i = 0; i < 150; i++) {
  a.step(1 / 60, 4);
  if (i % 30 === 0) console.log(`step ${i}: y=${a.getTestY().toFixed(3)}`);
}
const y = a.getTestY();
console.log(`final y=${y.toFixed(3)}`);

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
assert(y > 0.4 && y < 0.6, `box should settle at ~0.5, got ${y.toFixed(3)}`);
console.log('PASS: cube fell under gravity and settled on the ground');
