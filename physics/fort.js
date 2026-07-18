// Phase 5 check: build a castle and bombard it — assert the masonry (a) spawns
// stable (bricks don't explode apart on their own) and (b) caves in when boulders
// hit it. `bun physics/fort.js`
import { createArena } from './arena_api.js';

const arena = await createArena({ maxBodies: 8000 });
arena.createGround(200, 140);
const nBricks = arena.buildFort(0, 0, 12, 5);
console.log(`fort bricks: ${nBricks}`);

const XF = arena.XF_STRIDE;
// bricks are the handles after ground + 4 perimeter walls (= 5). The transform
// buffer is only filled by arena_step, so step once before reading positions.
const base = 5;
arena.step(1 / 60, 8);
const startY = [];
for (let h = base; h < base + nBricks; h++) startY.push(arena.transforms[h * XF + 1]);

// let it settle untouched; a stable spawn drifts only millimetres
for (let i = 0; i < 60; i++) arena.step(1 / 60, 8);
let drift = 0;
for (let i = 0; i < nBricks; i++) drift = Math.max(drift, Math.abs(arena.transforms[(base + i) * XF + 1] - startY[i]));
console.log(`max brick settle drift: ${drift.toFixed(3)} m`);

// bombard the solid back wall (z=+8) head-on at brick height so boulders strike
// the masonry (static walls only breach where a rock actually hits them)
for (let i = 0; i < 8; i++) arena.addBoulder(-7 + i * 2, 2.5, 30, 0, 0, -42, 1.4);
for (let i = 0; i < 150; i++) arena.step(1 / 60, 8);

let moved = 0, maxDisp = 0;
for (let i = 0; i < nBricks; i++) {
  const o = (base + i) * XF;
  const disp = Math.hypot(arena.transforms[o] - 0, arena.transforms[o + 1] - startY[i]); // rough
  if (Math.abs(arena.transforms[o + 1] - startY[i]) > 0.5) moved++;
  maxDisp = Math.max(maxDisp, Math.abs(arena.transforms[o + 1] - startY[i]));
}
console.log(`bricks displaced by bombardment: ${moved}/${nBricks} (max vertical disp ${maxDisp.toFixed(2)} m)`);

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
assert(nBricks > 200, `fort should be substantial masonry, got ${nBricks}`);
assert(drift < 1.0, `masonry must spawn stable (drift ${drift.toFixed(2)} >= 1.0)`);
assert(moved > 5, `bombardment should cave in the wall (only ${moved} bricks moved)`);
console.log('PASS: fort spawns stable and caves in under bombardment');
