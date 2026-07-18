// Central scaling knobs, shared by sim.js (server + solo) and battle.js (render).
// Conservative defaults run on a laptop; the "high-end" comments show values a
// strong GPU/CPU can take. Server body counts are also overridable via CLI flags
// (see server.js --t0/--t1/--fort). Defaults must keep `make wasm-bench` green.
export const CONFIG = {
  maxBodies: 12000,     // physics body pool (soldiers + fort bricks + boulders + corpses)
  subSteps: 4,          // box3d solver sub-steps/tick; 8 = stiffer masonry, more cost
  ragdollLifetime: 4,   // seconds a corpse lingers before its body is freed
  heroesPerTeam: 1,     // VRM leader models per team (rest of the army is instanced)

  // fort (siege) layout, used when fort mode is on. Two castles, one per team at
  // its backline (backZ), gates facing the enemy. Each team's stance decides
  // whether it holds its own fort ('defend') or storms the enemy's ('attack').
  fort: { halfSize: 8, courses: 5, backZ: 56, navCell: 2, stance: ['attack', 'defend'] },

  // render instance caps — raise together with body counts on a beefy GPU
  render: {
    brickCap: 2000,     // high-end: 6000+
    ragdollCap: 400,    // concurrent corpse capsules drawn
  },
};
