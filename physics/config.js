// Central scaling knobs, shared by sim.js (server + solo) and battle.js (render).
// A TIER (low|mid|high|ultra) scales the whole scene at once — army size, ragdoll
// count, castle detail, and render settings — so you can crank it up from a laptop
// to a stress-test on a big GPU. Pick with `make start TIER=high` or --tier.
export const CONFIG = {
  tier: 'low',
  maxBodies: 60000,     // physics body pool — large so ultra fits (soldiers+bricks+boulders+ragdoll bones)
  subSteps: 2,          // box3d solver sub-steps/tick; higher = stiffer masonry, more cost
  players: [4, 4],      // armies per side; tier/CLI can override
  unitScale: 1,         // multiplies each unit's soldier count (tier scales battle size)
  ragdolls: { cap: 48, lifetime: 5 },  // real jointed ragdolls on death (14 bodies each), pooled
  heroesPerTeam: 1,     // animated GLB champion models per team (rest instanced humanoids)

  // fort (siege): each team fields a walled city. BOTH attack by default (mutual
  // siege race — no predetermined loser); armies split into assault + home guard,
  // and assaults STAGE at a standoff ring until artillery opens a breach.
  fort: { halfSize: 8, courses: 5, backZ: 60, navCell: 2, stance: ['attack', 'attack'] },

  // client render knobs (sent to clients in `init` so they match the server tier)
  render: {
    brickCap: 6000,      // instanced brick cap (fort + rubble)
    soldier: 'humanoid', // 'humanoid' articulated figures, or 'capsule' for max perf
    charHeight: 1.7,     // every VRM is auto-scaled to this height (m) so any model fits
    vrmCap: 4000,        // above every tier's per-side count, so the WHOLE army is VRM at
                         // every tier (the tiers themselves ramp the load — see below)
    shadows: false,
    pixelRatio: 2,
  },
};

// Scene tiers — a smooth VRM ramp. Every tier is 100% VRM (vrmCap is above the top
// count), so tiers scale the actual VRM load evenly: ~2 more columns per step,
// roughly +1000 avatars/side each. `low` (~1k/side) is the comfortable baseline;
// `xt` (~3k/side, ~6k clones) is the ceiling stress. Castle detail/ragdolls ramp too.
//                players   per-side  clones
const TIERS = {
  low:   { players: [4, 4],   unitScale: 1.0, ragdolls: { cap: 48,  lifetime: 5 }, fortCourses: 5, render: { brickCap: 8000,  soldier: 'humanoid', shadows: false, pixelRatio: 2 } }, // ~1050  ~2.1k
  mid:   { players: [6, 6],   unitScale: 1.0, ragdolls: { cap: 64,  lifetime: 6 }, fortCourses: 6, render: { brickCap: 12000, soldier: 'humanoid', shadows: false, pixelRatio: 2 } }, // ~1580  ~3.2k
  high:  { players: [8, 8],   unitScale: 1.0, ragdolls: { cap: 90,  lifetime: 6 }, fortCourses: 7, render: { brickCap: 18000, soldier: 'humanoid', shadows: false, pixelRatio: 2 } }, // ~2100  ~4.2k
  ultra: { players: [10, 10], unitScale: 1.0, ragdolls: { cap: 110, lifetime: 7 }, fortCourses: 8, render: { brickCap: 24000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } }, // ~2650  ~5.3k
  xt:    { players: [12, 12], unitScale: 1.0, ragdolls: { cap: 128, lifetime: 8 }, fortCourses: 8, render: { brickCap: 30000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } }, // ~3150  ~6.3k
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
