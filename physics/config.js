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

  // fort (siege): ONE walled city occupies the DEFENDER's side; the other team is the
  // ATTACKER and must breach in. `defender` picks which team holds the city (0 or 1).
  // fort (mutual siege): both teams field a walled city and attack. invasion: ONE team
  // (defender) holds a city occupying its whole side, the other rams in. defender picks
  // which team holds the city in invasion mode.
  fort: { halfSize: 8, courses: 5, backZ: 60, navCell: 2, stance: ['attack', 'attack'], defender: 1 },

  // client render knobs (sent to clients in `init` so they match the server tier)
  render: {
    brickCap: 6000,      // instanced brick cap (fort + rubble)
    soldier: 'humanoid', // 'humanoid' articulated figures, or 'capsule' for max perf
    chars: 'humanoid',   // army art: 'humanoid' (original instanced figures + capsule ragdolls, fastest),
                         // 'glb' (KayKit clones) or 'vrm' (three-vrm avatars). Menu/--chars overrides.
    vrmCap: 4000,        // above every tier's per-side count — the WHOLE army is rendered at every tier
    charScale: 0.9,      // GLB gladiator size (tune to match the ranks; 1.0 ≈ model's native height)
    charHeight: 1.05,    // VRM avatars auto-scaled to this height (m) — soldier-sized
    shadows: false,
    pixelRatio: 2,
  },
};

// Scene tiers — a smooth GLB ramp. Every tier is 100% GLB (vrmCap is above the top
// count), +2 columns / ~+520 avatars per side per step. low 4v4 (~1k/side) baseline
// -> xt 12v12 (~3.1k/side). GLB is light (low-poly), so this scales much better than
// VRM. Castle detail + ragdoll caps ramp alongside.
const TIERS = {
  low:   { players: [4, 4],   unitScale: 0.25, ragdolls: { cap: 48,  lifetime: 5 }, fortCourses: 5, render: { brickCap: 8000,  soldier: 'humanoid', shadows: false, pixelRatio: 2 } }, // ~270/side
  mid:   { players: [6, 6],   unitScale: 0.45, ragdolls: { cap: 64,  lifetime: 6 }, fortCourses: 6, render: { brickCap: 12000, soldier: 'humanoid', shadows: false, pixelRatio: 2 } }, // ~700/side
  high:  { players: [8, 8],   unitScale: 0.65, ragdolls: { cap: 90,  lifetime: 6 }, fortCourses: 7, render: { brickCap: 18000, soldier: 'humanoid', shadows: false, pixelRatio: 2 } }, // ~1350/side
  ultra: { players: [10, 10], unitScale: 0.85, ragdolls: { cap: 110, lifetime: 7 }, fortCourses: 8, render: { brickCap: 24000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } }, // ~2200/side
  xt:    { players: [12, 12], unitScale: 1.0,  ragdolls: { cap: 128, lifetime: 8 }, fortCourses: 8, render: { brickCap: 30000, soldier: 'humanoid', shadows: true,  pixelRatio: 2 } }, // ~3150/side
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
