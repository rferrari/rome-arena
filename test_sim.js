// Headless battle: all slots AI, run up to 5 sim-minutes, assert the
// mechanics actually fire. `make test`.
import { createSim } from './sim.js';
import { createArena } from './physics/arena_api.js';

const arena = await createArena({ maxBodies: 8000 });
const sim = createSim({ seed: 7, players: [2, 2], arena });
console.log(`units: ${sim.units.length}, soldiers: ${sim.soldiers.length}`);

const t0 = performance.now();
let steps = 0;
while (sim.winner === null && sim.time < 300) { sim.step(1 / 30); steps++; }
const wall = performance.now() - t0;
sim.drainEvents();

const s = sim.stats;
console.log(`winner: ${sim.winner === null ? 'timeout' : ['Red', 'Blue'][sim.winner]} at t=${sim.time.toFixed(1)}s`);
console.log(`perf: ${steps} steps in ${wall.toFixed(0)}ms wall (${(wall / steps).toFixed(2)}ms/step, budget 33ms)`);
console.log(JSON.stringify(s, null, 1));

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
assert(sim.winner !== null, 'battle should resolve within 5 sim-minutes');
assert(s.arrows.fired > 100 && s.arrows.hits > 0, 'archers fire and hit');
assert(s.boulders.fired > 0, 'catapults fire');
assert(s.spearVsCav.n > 0, 'anti-cavalry bonus triggers');
assert(s.charge.n > 0, 'cavalry charge bonus triggers');
assert(s.blockMelee.n + s.blockRanged.n > 0, 'shield wall blocks damage (AI pikes form phalanx)');
assert(s.routs > 0, 'morale breaks happen');
assert(wall / steps < 33, 'sim step fits the 30Hz budget');
console.log('ALL CHECKS PASS');
