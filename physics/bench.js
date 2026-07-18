// Phase 2 perf gate: the body-count budget check. Spawn 500 soldier capsules +
// 1000 static bricks (settled masonry) + 20 boulders, drive soldier intents, and
// assert the batch step stays under the 30Hz budget (33 ms/step).  `bun physics/bench.js`
//
// If this fails, the plan falls back to movers-only soldiers before Phase 3.
import { createArena } from './arena_api.js';

const FIELD_W = 200, FIELD_D = 140;
const N_SOLDIERS = 500, N_BRICKS = 1000, N_BOULDERS = 20, STEPS = 300;

const arena = await createArena({ maxBodies: 4000 });
arena.createGround(FIELD_W, FIELD_D);

const soldiers = [];
for (let i = 0; i < N_SOLDIERS; i++) {
  const x = -40 + (i % 25) * 3.2;
  const z = -30 + Math.floor(i / 25) * 3.2;
  soldiers.push(arena.addSoldier(x, z));
}
for (let i = 0; i < N_BRICKS; i++) {
  const x = -20 + (i % 40) * 1.0;
  const z = 40 + Math.floor(i / 40) * 1.0;
  arena.addBrick(x, 0.5, z, 0.5, 0.5, 0.5, false); // static settled brick
}
for (let i = 0; i < N_BOULDERS; i++) arena.addBoulder(-57 + i * 6, 20, -40, 4, 5, 9, 1.2);

console.log(`bodies: ${arena.count} (${N_SOLDIERS} soldiers, ${N_BRICKS} bricks, ${N_BOULDERS} boulders)`);

const march = () => { const it = arena.intents; for (const h of soldiers) { it[h * 2] = 0; it[h * 2 + 1] = 4; } };
for (let i = 0; i < 10; i++) { march(); arena.step(1 / 30, 4); } // warmup

const t0 = performance.now();
for (let i = 0; i < STEPS; i++) { march(); arena.step(1 / 30, 4); }
const wall = performance.now() - t0;
const perStep = wall / STEPS;

const xf = arena.transforms, s0 = soldiers[0] * 8;
console.log(`${STEPS} steps in ${wall.toFixed(0)}ms  (${perStep.toFixed(2)} ms/step, budget 33)`);
console.log(`soldier0 pos = (${xf[s0].toFixed(2)}, ${xf[s0 + 1].toFixed(2)}, ${xf[s0 + 2].toFixed(2)})`);

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
// capsule body origin rests at ~-0.05 (lowest sphere center 0.40, radius 0.35);
// the check that matters is it settled on the ground and didn't tunnel through.
assert(xf[s0 + 1] > -0.4 && xf[s0 + 1] < 1.5, `soldier should rest on the ground, y=${xf[s0 + 1].toFixed(2)}`);
assert(xf[s0 + 2] > -30, 'soldier should have marched in +z');
assert(perStep < 33, `step budget exceeded: ${perStep.toFixed(2)}ms >= 33ms`);
console.log('PASS: physics fits the 30Hz budget');
