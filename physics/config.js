// Central scaling knobs, shared by sim.js (server + solo) and battle.js (render).
// A TIER (low|mid|high|ultra) scales the whole scene at once — army size, ragdoll
// count, castle detail, and render settings — so you can crank it up from a laptop
// to a stress-test on a big GPU. Pick with `make start TIER=high` or --tier.
export const CONFIG = {
  tier: 'low',
  maxBodies: 60000,     // physics body pool — large so ultra fits (soldiers+bricks+boulders+ragdoll bones)
  subSteps: 4,          // box3d solver sub-steps/tick; 8 = stiffer masonry, more cost
  players: [4, 4],      // armies per side; tier/CLI can override
  unitScale: 1,         // multiplies each unit's soldier count (tier scales battle size)
  ragdolls: { cap: 48, lifetime: 5 },  // real jointed ragdolls on death (14 bodies each), pooled
  heroesPerTeam: 1,     // animated GLB champion models per team (rest instanced humanoids)

  // fort (siege): THREE castles per team in a row at its backline, gates facing the
  // enemy. stance decides whether a team holds its own forts ('defend') or storms the enemy's.
  fort: { halfSize: 8, courses: 5, backZ: 60, navCell: 2, stance: ['attack', 'defend'] },

  // client render knobs (sent to clients in `init` so they match the server tier)
  render: {
    brickCap: 6000,      // instanced brick cap (fort + rubble)
    soldier: 'humanoid', // 'humanoid' articulated figures, or 'capsule' for max perf
    shadows: false,
    pixelRatio: 2,
  },
};

// Scene tiers — scale army size (players + unitScale), ragdolls, castle detail and
// render together. Rebalanced upward: "low" is now a full 4v4 (what used to be the
// top), and each step multiplies unit sizes for real stress testing.
const TIERS = {
  low:   { players: [4, 4], unitScale: 1.0, ragdolls: { cap: 48,  lifetime: 5 }, fortCourses: 5, render: { brickCap: 8000,  soldier: 'humanoid', shadows: false, pixelRatio: 2 } },
  mid:   { players: [6, 6], unitScale: 1.0, ragdolls: { cap: 80,  lifetime: 6 }, fortCourses: 6, render: { brickCap: 12000, soldier: 'humanoid', shadows: false, pixelRatio: 2 } },
  high:  { players: [8, 8], unitScale: 1.0, ragdolls: { cap: 110, lifetime: 7 }, fortCourses: 7, render: { brickCap: 18000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } },
  ultra: { players: [8, 8], unitScale: 1.5, ragdolls: { cap: 128, lifetime: 8 }, fortCourses: 8, render: { brickCap: 30000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } },
};

// Apply a tier's numbers into CONFIG (server side); returns the resolved tier name.
export function setTier(name) {
  const t = TIERS[name];
  if (!t) return CONFIG.tier;
  CONFIG.tier = name;
  CONFIG.players = t.players.slice();
  CONFIG.unitScale = t.unitScale;
  CONFIG.ragdolls = { ...t.ragdolls };
  CONFIG.fort.courses = t.fortCourses;
  CONFIG.render = { ...CONFIG.render, ...t.render };
  return name;
}
