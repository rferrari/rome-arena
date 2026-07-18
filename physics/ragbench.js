// Find a good ragdoll cap: with a battle-scale scene (600 soldiers + a fort), spawn
// N jointed ragdolls and measure ms/step. Sweeps caps until the 30Hz budget (33ms)
// gets tight. `bun physics/ragbench.js`
import { createArena } from './arena_api.js';

const caps = [2, 4, 8, 16, 24, 32, 48, 64, 96];
for (const cap of caps) {
  const arena = await createArena({ maxBodies: 16000 });
  arena.createGround(200, 140);
  arena.setRagdollParams(cap, 999); // long life so all stay active during the test
  const sol = [];
  for (let i = 0; i < 600; i++) sol.push(arena.addSoldier(-40 + (i % 30) * 2.6, -30 + ((i / 30) | 0) * 2.6));
  arena.buildFort(0, 40, 8, 5, -1);
  // spawn `cap` ragdolls spread out
  for (let i = 0; i < cap; i++) arena.spawnRagdoll(-30 + (i % 12) * 5, 3, 10 + ((i / 12) | 0) * 4, 0, 0, 0);

  const march = () => { const it = arena.intents; for (const h of sol) { it[h * 2] = 0; it[h * 2 + 1] = 3; } };
  for (let i = 0; i < 20; i++) { march(); arena.step(1 / 30, 4); } // warmup + let ragdolls settle
  const N = 200, t0 = performance.now();
  for (let i = 0; i < N; i++) { march(); arena.step(1 / 30, 4); }
  const ms = (performance.now() - t0) / N;
  console.log(`cap ${String(cap).padStart(3)}  (${cap * 14} bone bodies)  ->  ${ms.toFixed(2)} ms/step  ${ms < 33 ? 'OK' : 'OVER BUDGET'}`);
}
