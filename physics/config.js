// Central scaling knobs, shared by sim.js (server + solo) and battle.js (render).
// A TIER (low|mid|high|ultra) scales the whole scene at once — army size, ragdoll
// count, castle detail, and render settings — so you can crank it up from a laptop
// to a stress-test on a big GPU. Pick with `make start TIER=high` or --tier.
export const CONFIG = {
  tier: 'mid',
  maxBodies: 60000,     // physics body pool — large so ultra fits (soldiers+bricks+boulders+ragdoll bones)
  subSteps: 4,          // box3d solver sub-steps/tick; 8 = stiffer masonry, more cost
  players: [2, 2],      // armies per side (each ~255 soldiers); tier/CLI can override
  ragdolls: { cap: 32, lifetime: 5 },  // real jointed ragdolls on death (14 bodies each), pooled
  heroesPerTeam: 1,     // animated GLB champion models per team (rest instanced humanoids)

  // fort (siege): two castles, one per team at its backline, gates facing the enemy.
  // stance decides whether a team holds its own fort ('defend') or storms the enemy's.
  fort: { halfSize: 8, courses: 5, backZ: 56, navCell: 2, stance: ['attack', 'defend'] },

  // client render knobs (sent to clients in `init` so they match the server tier)
  render: {
    brickCap: 6000,      // instanced brick cap (fort + rubble)
    soldier: 'humanoid', // 'humanoid' articulated figures, or 'capsule' for max perf
    shadows: false,
    pixelRatio: 2,
  },
};

// Scene tiers — scale army/ragdolls/castle/render together. Not shy about numbers;
// crank the tier until the machine complains.
const TIERS = {
  low:   { players: [1, 1], ragdolls: { cap: 8,   lifetime: 4 }, fortCourses: 4, render: { brickCap: 2000,  soldier: 'humanoid', shadows: false, pixelRatio: 1 } },
  mid:   { players: [2, 2], ragdolls: { cap: 32,  lifetime: 5 }, fortCourses: 5, render: { brickCap: 6000,  soldier: 'humanoid', shadows: false, pixelRatio: 2 } },
  high:  { players: [3, 3], ragdolls: { cap: 80,  lifetime: 6 }, fortCourses: 6, render: { brickCap: 12000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } },
  ultra: { players: [4, 4], ragdolls: { cap: 128, lifetime: 8 }, fortCourses: 8, render: { brickCap: 24000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } },
};

// Apply a tier's numbers into CONFIG (server side); returns the resolved tier name.
export function setTier(name) {
  const t = TIERS[name];
  if (!t) return CONFIG.tier;
  CONFIG.tier = name;
  CONFIG.players = t.players.slice();
  CONFIG.ragdolls = { ...t.ragdolls };
  CONFIG.fort.courses = t.fortCourses;
  CONFIG.render = { ...CONFIG.render, ...t.render };
  return name;
}
