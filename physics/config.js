// Central scaling knobs, shared by sim.js (server + solo) and battle.js (render).
// Conservative defaults run on a laptop; the "high-end" comments show values a
// strong GPU/CPU can take. Server body counts are also overridable via CLI flags
// (see server.js --t0/--t1/--fort). Defaults must keep `make wasm-bench` green.
export const CONFIG = {
  maxBodies: 16000,     // physics body pool (soldiers + fort bricks + boulders + ragdoll bones)
  subSteps: 4,          // box3d solver sub-steps/tick; 8 = stiffer masonry, more cost
  // real box3d jointed ragdolls spawned on death (each = 14 bodies + joints),
  // pooled and round-robin recycled at `cap`. Raise cap on strong hardware.
  // 32 is a lively default; the perf gate stays green well past 96 (ragbench.js).
  ragdolls: { cap: 32, lifetime: 5 },
  heroesPerTeam: 1,     // animated GLB champion models per team (rest instanced)

  // fort (siege) layout, used when fort mode is on. Two castles, one per team at
  // its backline (backZ), gates facing the enemy. Each team's stance decides
  // whether it holds its own fort ('defend') or storms the enemy's ('attack').
  fort: { halfSize: 8, courses: 5, backZ: 56, navCell: 2, stance: ['attack', 'defend'] },

  // render instance caps — raise together with body counts on a beefy GPU
  render: {
    brickCap: 2600,     // high-end: 6000+
  },
};
