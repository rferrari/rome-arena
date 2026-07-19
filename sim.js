// Pure battle simulation — no three.js, no DOM. Runs on the server (bun)
// and in the browser (solo fallback). Server-authoritative: clients only
// send orders, so there is no lockstep desync class of bugs.

import { CONFIG } from './physics/config.js';
import { createFlowField } from './physics/flowfield.js';

export const FIELD_W = 375, FIELD_D = 300; // big field: wide flanks + deep approach (cities fit well inside)
export const SPACING = 1.3;

export const TYPES = {
  //          count files hp   dmg dmgVar range speed cd
  legion:  { n: 48, files: 8,  hp: 100, dmg: 20, dmgVar: 15, range: 1.7, speed: 7,   cd: 1.0,
             alt: { name: 'testudo', spacing: 0.8, speedMult: 0.5, rangedTaken: 0.2, meleeTaken: 0.55, dmgMult: 0.7 } },
  spear:   { n: 48, files: 8,  hp: 100, dmg: 16, dmgVar: 12, range: 2.2, speed: 6.5, cd: 1.1, vsCav: 2.5 },
  pike:    { n: 48, files: 8,  hp: 100, dmg: 14, dmgVar: 10, range: 3.4, speed: 5,   cd: 1.2, vsCav: 3,
             alt: { name: 'phalanx', spacing: 0.85, speedMult: 0.45, meleeTaken: 0.75, dmgMult: 1.35 } },
  archer:  { n: 36, files: 12, hp: 70,  dmg: 8,  dmgVar: 8,  range: 1.4, speed: 7.5, cd: 1.2,
             ranged: { range: 45, cd: 3, dmg: 9, dmgVar: 8 } },
  cavalry: { n: 24, files: 8,  hp: 140, dmg: 25, dmgVar: 15, range: 2.0, speed: 14,  cd: 1.0, charge: 2.5 },
  catapult:{ n: 3,  files: 3,  hp: 100, dmg: 10, dmgVar: 8,  range: 1.7, speed: 4,   cd: 1.2 },
};
export const COMP_FRONT = ['legion', 'legion', 'spear', 'pike'];
export const COMP_BACK = ['archer', 'cavalry'];

const ATTACK_CD_JIT = 0.2, SEEK_RANGE = 5;
const CAT_RANGE = 75, CAT_MIN_RANGE = 15, CAT_CD = 5, CAT_AOE = 7;
const GRAVITY = 10, BOULDER_R = 1.2, BOULDER_DMG = 110, BOULDER_LIFE = 3, BOULDER_LAUNCH_Y = 3;
const CELL = 5;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ponytail: mulberry32, same 8 lines as mapgen — importing arena.js would drag three.js in
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SUBSTEPS = CONFIG.subSteps; // box3d solver sub-steps per tick

export function createSim({ seed = 1, players = [2, 2], arena, fort = false, dom = false, ctf = false } = {}) {
  if (!arena) throw new Error('createSim requires a physics arena (see physics/arena_api.js)');
  arena.reset(seed >>> 0);            // fresh box3d world + body tables
  arena.createGround(FIELD_W, FIELD_D); // static floor + perimeter walls
  arena.setRagdollParams(CONFIG.ragdolls.cap, CONFIG.ragdolls.lifetime);
  const rng = mulberry32(seed);
  const units = [], soldiers = [], projectiles = [], arrows = [];
  const boulders = [];                 // live catapult rocks: { h, born, hits }
  const soldierByHandle = new Map();   // box3d body handle -> soldier (for contacts)
  const events = [];
  const stats = {
    spearVsCav: { n: 0, dmg: 0 },   // bonus dmg from anti-cavalry weapons
    charge: { n: 0, dmg: 0 },       // cavalry charge impact bonus
    phalanxDmg: { n: 0, dmg: 0 },   // extra dmg dealt by phalanx stance
    blockMelee: { n: 0, dmg: 0 },   // melee dmg absorbed by testudo/phalanx
    blockRanged: { n: 0, dmg: 0 },  // ranged dmg absorbed by shield wall
    arrows: { fired: 0, hits: 0 },
    boulders: { fired: 0, kills: 0 },
    firepots: 0,                    // exploding shots detonated
    crushed: 0,                     // soldiers killed by flying masonry
    routs: 0, rallies: 0,
  };
  const sim = {
    units, soldiers, stats, players, winner: null, time: 0, arena,
    ai: new Set(), // 'team:slot' keys driven by the built-in AI
    step, order, toggleStance, adjustFiles,
    drainEvents: () => events.splice(0),
  };
  const teamName = (t) => (t === 0 ? 'Red' : 'Blue');

  function forward(a) { return { x: Math.sin(a), z: Math.cos(a) }; }
  function spacing(u) { return u.stance && u.type.alt ? u.type.alt.spacing : SPACING; }
  function slotPos(u, i, out) {
    const sp = spacing(u);
    const row = Math.floor(i / u.files), col = i % u.files;
    const lx = (col - (u.files - 1) / 2) * sp, lz = row * sp;
    const f = forward(u.facing);
    out.x = u.ax + f.z * lx - f.x * lz;
    out.z = u.az - f.x * lx - f.z * lz;
    return out;
  }

  // count: explicit for CTF squads; otherwise scaled by the tier's unitScale.
  // opts: { y } spawns the whole unit elevated (battlement garrisons stand on real
  // wall bricks); { garrison } locks it in place — it holds the wall and shoots.
  function makeUnit(team, slot, typeKey, ax, az, facing, count, opts = {}) {
    const type = TYPES[typeKey];
    const n = count ?? (typeKey === 'catapult' ? type.n : Math.max(4, Math.round(type.n * (CONFIG.unitScale || 1))));
    const u = {
      id: units.length, team, slot, typeKey, type, n0: n,
      ax, az, facing, files: Math.max(2, Math.min(opts.files || type.files, n)), stance: 0,
      morale: 100, broken: false, alive: n, garrison: !!opts.garrison,
      cx: ax, cz: az, catCd: CAT_CD * rng(), soldiers: [],
    };
    const p = { x: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      slotPos(u, i, p);
      const s = {
        id: soldiers.length, unit: u, slot: i,
        x: p.x, z: p.z, face: facing, hp: type.hp,
        cd: rng(), cdR: rng() * 2, state: 0 /* 0 alive 1 dying 2 gone */,
        deathT: 0, fightT: 0, mom: 0, down: 0,
        speed: type.speed * (0.9 + rng() * 0.2),
        h: arena.addSoldier(p.x, p.z, opts.y || 0), // box3d capsule body handle
      };
      u.soldiers.push(s); soldiers.push(s); soldierByHandle.set(s.h, s);
    }
    units.push(u);
    return u;
  }

  // ---- capture the flag: small squads + a flag at each team's base ----
  let flags = null, scores = null;
  const CTF = { pick: 2.6, cap: 4.0, target: 3, baseZ: 107, returnT: 15 };
  if (ctf) {
    // small readable squads: fast cavalry runners + a legion escort per player slot
    const COMP_CTF = [['cavalry', 8], ['legion', 12]];
    for (let team = 0; team < 2; team++) {
      const dir = team === 0 ? 1 : -1, facing = team === 0 ? Math.PI : 0;
      const blockW = Math.min(30, (FIELD_W - 10) / players[team]);
      for (let p = 0; p < players[team]; p++) {
        const bx = (p + 0.5 - players[team] / 2) * blockW;
        COMP_CTF.forEach(([t, cnt], i) =>
          makeUnit(team, p, t, bx + (i - (COMP_CTF.length - 1) / 2) * 8, dir * 79, facing, cnt));
        sim.ai.add(`${team}:${p}`);
      }
    }
    flags = [
      { team: 0, hx: 0, hz: CTF.baseZ, x: 0, z: CTF.baseZ, carrier: null, state: 'base', dropT: 0 },
      { team: 1, hx: 0, hz: -CTF.baseZ, x: 0, z: -CTF.baseZ, carrier: null, state: 'base', dropT: 0 },
    ];
    scores = [0, 0];
    sim.flags = flags; sim.scores = scores; sim.ctf = true;
  } else {
  // deployment: per player slot, 4 melee units front, archer+cavalry behind, catapult
  // rear. In fort mode armies form up further forward so each team's castle sits
  // behind them at ±backZ.
  // Each player is a compact combined-arms BATTLE GROUP: the 4 melee units in a 2x2
  // block, archer+cavalry a rank behind, catapults at the rear. Unit rank-width is
  // FITTED to its column slot so nothing spawns overlapping, and lanes are left
  // between groups (cavalry can sweep them). Alternate groups sit half a rank deeper.
  const nCat = fort ? 3 : 1;
  const frontZ0 = fort ? 30 : 60; // front rank's distance from centre
  for (let team = 0; team < 2; team++) {
    const dir = team === 0 ? 1 : -1, facing = team === 0 ? Math.PI : 0;
    const blockW = Math.min(48, (FIELD_W - 20) / players[team]);
    const perCol = (blockW * 0.6) / 2;                                  // 2 columns per group
    const fFiles = clamp(Math.floor(perCol / SPACING), 3, 8);          // fit rank width to the slot
    const bFiles = clamp(Math.floor(perCol / SPACING), 3, 12);
    const legN = Math.max(4, Math.round(48 * (CONFIG.unitScale || 1)));
    const rowGap = Math.ceil(legN / fFiles) * SPACING + 3;             // one unit-row deep + a gap
    for (let p = 0; p < players[team]; p++) {
      const bx = (p + 0.5 - players[team] / 2) * blockW;
      const zg = (p % 2 ? rowGap * 0.5 : 0) * dir;                     // gentle checkerboard stagger
      COMP_FRONT.forEach((t, i) => {                                    // 2x2 melee block
        const col = i % 2, row = (i / 2) | 0;
        makeUnit(team, p, t, bx + (col - 0.5) * perCol, dir * (frontZ0 + row * rowGap) + zg, facing, undefined, { files: fFiles });
      });
      COMP_BACK.forEach((t, i) =>                                       // archer + cavalry a rank behind
        makeUnit(team, p, t, bx + (i - 0.5) * perCol, dir * (frontZ0 + 2 * rowGap) + zg, facing, undefined, { files: bFiles }));
      for (let k = 0; k < nCat; k++)                                    // catapults at the rear
        makeUnit(team, p, 'catapult', bx + (k - (nCat - 1) / 2) * 7, dir * (frontZ0 + 3 * rowGap) + zg, facing);
      sim.ai.add(`${team}:${p}`); // owners claim their slot; unclaimed = AI
    }
  }
  }

  // Castles in a V per team: two small watchtowers pushed FORWARD on the flanks and
  // one big king castle back-centre. Each fort's battlements carry an archer garrison
  // standing on the real wall bricks — breach the wall and the garrison comes down
  // with it. stance decides holding your own forts vs storming the enemy's.
  // Default off so open-field test_sim is unaffected.
  // Two MEDIEVAL CITIES face each other. Both keep two forward watchtowers near
  // midfield (smashed, they collapse into rubble walls). Red's capital is a GRID
  // city: square king castle plus square-house districts on straight streets.
  // Blue's is a RADIAL "onion": a round keep inside a gated circular curtain,
  // ringed by round houses. Battlement archer garrisons stand on the real wall
  // bricks. Default off so open-field test_sim is unaffected.
  let nav = null, teamForts = null, teamStance = null, navT = 0, engines = null;
  let caps = null;                            // each team's capital (assault objective)
  const assault = ['stage', 'stage'];         // per-team phase: 'stage' -> 'storm'
  let lastKill = 0;                           // sim.time of the last death (stalemate detection)
  if (fort) {
    const F = CONFIG.fort;
    teamStance = F.stance;
    teamForts = [[], []];
    // a square house: 4 walls with door gaps at the corners (static, cheap)
    const house = (cx, cz, hw = 3) => {
      const g = 0.7, hc = 3;
      arena.buildWall(cx - hw + g, cz - hw, cx + hw - g, cz - hw, hc);
      arena.buildWall(cx - hw + g, cz + hw, cx + hw - g, cz + hw, hc);
      arena.buildWall(cx - hw, cz - hw + g, cx - hw, cz + hw - g, hc);
      arena.buildWall(cx + hw, cz - hw + g, cx + hw, cz + hw - g, hc);
    };
    for (let t = 0; t < 2; t++) {
      const dir = t === 0 ? 1 : -1, facing = t === 0 ? Math.PI : 0;
      // forward watchtowers near the CENTRE (both cities) — a SINGLE round tower each
      // (not a full fort), pulled ~30% back toward each team's own side. They're
      // lookout/garrison points, not gated objectives, so they're `tower:true` and the
      // flow field routes AROUND them rather than trying to enter them.
      for (const tx of [-50, 50]) {
        arena.buildRondel(tx, dir * 42, 4, 10, F.courses + 2); // one solid round tower
        teamForts[t].push({ cx: tx, cz: dir * 42, hs: 4, courses: F.courses + 2, tower: true });
      }
      if (t === 0) {
        // RED — walled GRID city (Roman castrum): a curtain wall with one front gate,
        // WIDE straight streets of well-spaced house blocks, and the king castle at
        // the back-centre (the assault objective; its gate faces the enemy).
        arena.buildFort(0, 105, 14, F.courses + 3, -1);
        teamForts[t].push({ cx: 0, cz: 105, hs: 14, courses: F.courses + 3, gate: -1 });
        const cw = 5, rf = 80, rb = 131;                          // tall city curtain: front z, back z
        arena.buildWall(-92, rf, -9, rf, cw); arena.buildWall(9, rf, 92, rf, cw);   // front + central gate gap
        arena.buildWall(-92, rf, -92, rb, cw); arena.buildWall(92, rf, 92, rb, cw); // side walls
        // manned gatehouse: archers on the front wall either side of the gate
        for (const gx of [-30, 30]) makeUnit(t, 0, 'archer', gx, rf, facing, 4, { y: cw + 0.15, garrison: true });
        // house grid on wide streets (clear of the central avenue and the castle)
        for (const hx of [-82, -55, -28, 28, 55, 82]) for (const hz of [88, 120]) house(hx, hz, 4);
      } else {
        // BLUE — concentric ONION city: a central keep, a gated curtain (the objective),
        // and an OUTER ring wall whose gate lines up so attackers must pass through both
        // (an onion of walls), with well-spaced round houses in the ring between them.
        const bz = -105;
        arena.buildRondel(0, bz, 6, 12, F.courses + 3);                                   // keep
        arena.buildRondel(0, bz, 17, 30, F.courses, Math.PI / 2, true);                   // curtain (objective), gate +z
        teamForts[t].push({ cx: 0, cz: bz, hs: 17, courses: F.courses, gate: 1 });
        const orc = Math.max(3, F.courses - 2);
        arena.buildRondel(0, bz, 33, 40, orc, Math.PI / 2, true);  // outer ring, gate +z
        // archers manning the outer ring's front, either side of its gate
        for (const gx of [-16, 16]) makeUnit(t, 0, 'archer', gx, bz + 30, facing, 4, { y: orc + 0.15, garrison: true });
        for (let k = 0; k < 8; k++) {                            // ring of houses between curtain & outer wall
          const a = (k + 0.5) * (Math.PI / 4);
          if (Math.sin(a) > 0.6) continue;                       // leave the +z gate lane clear
          arena.buildRondel(Math.cos(a) * 25, bz + Math.sin(a) * 25, 3, 7, 2);
        }
      }
      // battlement garrisons: on the tower tops (centre) and on each castle's rear crest
      for (const f of teamForts[t]) {
        const nArch = f.hs >= 10 ? 6 : 3;
        const gz = f.tower ? f.cz : f.cz + dir * f.hs; // towers: stand on top; castles: rear wall
        makeUnit(t, 0, 'archer', f.cx, gz, facing, nArch, { y: f.courses + 0.15, garrison: true });
      }
    }
    // jointed siege engines: two motor-swung trebuchets per team, plus one wheeled
    // siege tower per team that rolls up to a solid wall section and drops its drawbridge.
    engines = { trebs: [], towers: [] };
    for (let t = 0; t < 2; t++) {
      const dir = t === 0 ? 1 : -1, yaw = t === 0 ? Math.PI : 0;
      for (const tx of [-38, 38])
        engines.trebs.push({ id: arena.addTrebuchet(tx, dir * 86, yaw), team: t, x: tx, z: dir * 86, cd: 3 + rng() * 5 });
      // aim the tower at a SOLID curtain section (offset from the gate) of the nearest
      // enemy castle, so its drawbridge opens a fresh breach rather than the gate.
      // Spawn OUTSIDE our own walls (z=63), clear of the deployment rows.
      const id = arena.addTower(-22, dir * 63, yaw);
      engines.towers.push({ id, h: arena.towerHandle(id), team: t, dropped: false });
    }
    arena.sync();
    nav = [createFlowField(FIELD_W, FIELD_D, F.navCell), createFlowField(FIELD_W, FIELD_D, F.navCell)];
    sim.teamForts = teamForts;
    recomputeNav();

    // Battle plan: each team splits into ASSAULT columns and a HOME GUARD (every 3rd
    // column holds the line in front of its own city). Assaults advance to a staging
    // ring outside the enemy capital and HOLD while artillery breaches the walls —
    // then storm. No more suicide rush into an intact gate choke.
    caps = [teamForts[0].find((f) => !f.tower), teamForts[1].find((f) => !f.tower)];
    for (const u of units) {
      if (u.garrison || u.typeKey === 'catapult') continue;
      if (u.slot % 3 === 2) { u.role = 'guard'; u.homeX = u.ax; u.homeZ = u.az; }
    }
  }

  // Domination: three capture zones across the midfield. Holding a zone (more live
  // soldiers inside than the enemy) bleeds the enemy's tickets 1/zone/sec; a team
  // at 0 tickets loses. Gives commanders a reason to split and contest ground.
  let zones = null, tickets = null, domT = 0;
  if (dom) {
    // one zone in front of each team's home castle (x=0, z=±46) and one at midfield —
    // your own is easy to hold, the enemy's is a hard assault, the centre is the brawl
    zones = [{ x: 0, z: 58, r: 16, holder: -1 }, { x: 0, z: 0, r: 16, holder: -1 }, { x: 0, z: -58, r: 16, holder: -1 }];
    tickets = [400, 400];
    sim.zones = zones; sim.tickets = tickets;
  }
  // Wrath of the Gods: a called-in fire barrage (bonus ability, fort/dom battles) —
  // five fire-pot explosions march in a line toward the enemy side. One per team on
  // a long cooldown; humans aim it with B, the AI drops it on the densest formation.
  let strikes = null;
  const STRIKE_CD = 60;
  if (fort || dom) {
    strikes = { ready: [8, 8], queue: [] }; // first barrage available at t=8
    sim.strikeReadyIn = (team) => Math.max(0, strikes.ready[team] - sim.time); // seconds until ready (HUD)
    sim.strike = (team, x, z) => {
      if (sim.winner !== null) return false;
      if (sim.time < strikes.ready[team]) {
        events.push(['note', `Wrath of the Gods charging — ${Math.ceil(strikes.ready[team] - sim.time)}s`]);
        return false;
      }
      strikes.ready[team] = sim.time + STRIKE_CD;
      strikes.queue.push({
        x: clamp(x, -FIELD_W / 2 + 5, FIELD_W / 2 - 5),
        z: clamp(z, -FIELD_D / 2 + 5, FIELD_D / 2 - 5),
        dz: team === 0 ? -1 : 1, n: 5, t: 0,
      });
      events.push(['note', `${teamName(team)} calls the WRATH OF THE GODS!`]);
      return true;
    };
  }
  function strikeStep(dt) {
    for (let i = strikes.queue.length - 1; i >= 0; i--) {
      const q = strikes.queue[i];
      q.t -= dt;
      if (q.t > 0) continue;
      fireBomb(q.x + (rng() - 0.5) * 4, q.z + (rng() - 0.5) * 4);
      q.z += q.dz * 7; q.n--; q.t = 0.28;         // the barrage marches down the field
      if (!q.n) strikes.queue.splice(i, 1);
    }
  }

  function domStep() {
    for (const z of zones) {
      let c0 = 0, c1 = 0;
      const r2 = z.r * z.r;
      for (const s of soldiers) {
        if (s.state !== 0) continue;
        if ((s.x - z.x) ** 2 + (s.z - z.z) ** 2 < r2) { if (s.unit.team === 0) c0++; else c1++; }
      }
      const h = c0 > c1 ? 0 : c1 > c0 ? 1 : -1; // tie/empty keeps the current holder
      if (h !== -1 && h !== z.holder) { z.holder = h; events.push(['note', `${teamName(h)} captured a zone!`]); }
      if (z.holder !== -1) tickets[1 - z.holder] = Math.max(0, tickets[1 - z.holder] - 1);
    }
    if (sim.winner === null) {
      if (tickets[0] === 0) { sim.winner = 1; events.push(['over', 1]); }
      else if (tickets[1] === 0) { sim.winner = 0; events.push(['over', 0]); }
    }
  }

  // nav[t] = flow field for team t's attackers toward EVERY enemy castle (multi-source,
  // so each cell points to the nearest one). Blocks standing walls; breached rubble
  // (kind 6) opens a path. Recomputed periodically so breaches reroute the assault.
  function recomputeNav() {
    const xf = arena.transforms, ST = arena.XF_STRIDE, n = arena.count;
    for (let t = 0; t < 2; t++) {
      nav[t].clearBlocked();
      for (let h = 0; h < n; h++) { const b = h * ST; if (xf[b + 7] === 2) nav[t].blockWorld(xf[b], xf[b + 2]); }
      // goal = the courtyard just inside each ENTERABLE enemy castle's gate (solid
      // watchtowers are obstacles, not objectives — the field routes around them)
      const goals = teamForts[1 - t]
        .filter((f) => !f.tower)
        .map((f) => ({ x: f.cx, z: f.cz - (f.cz >= 0 ? 1 : -1) * (f.hs - 2) }));
      nav[t].compute(goals);
      // storm trigger: enough rubble blasted near the enemy capital (a usable breach),
      // or the siege has dragged on — sound the assault
      if (caps && assault[t] === 'stage') {
        const cap = caps[1 - t], r2 = (cap.hs + 10) ** 2;
        let rub = 0;
        for (let h = 0; h < n; h++) {
          const b = h * ST;
          if (xf[b + 7] === 6 && (xf[b] - cap.cx) ** 2 + (xf[b + 2] - cap.cz) ** 2 < r2) rub++;
        }
        if (rub > 18 || sim.time > 75) {
          assault[t] = 'storm';
          events.push(['note', `${teamName(t)} storms the breach!`]);
        }
      }
    }
  }
  function moveToSlot(s, u, speedMult, dt) {
    slotPos(u, s.slot, slotP);
    const d = Math.hypot(slotP.x - s.x, slotP.z - s.z);
    if (d > 0.15) { s.face = Math.atan2(slotP.x - s.x, slotP.z - s.z); setVel(s, slotP.x, slotP.z, s.speed * speedMult, dt); }
    else { s.face = u.facing; setStop(s); }
  }

  // ---- capture the flag: grab / carry / capture / drop-and-return ----
  function ctfStep(dt) {
    for (const f of flags) {
      const grab = 1 - f.team; // the enemy team steals f and runs it to their base
      if (f.state === 'carried') {
        const c = f.carrier;
        if (!c || c.state !== 0) { if (c) { f.x = c.x; f.z = c.z; } f.state = 'dropped'; f.dropT = 0; f.carrier = null; continue; }
        f.x = c.x; f.z = c.z;
        const base = flags[grab]; // grabber's home base
        if (Math.hypot(f.x - base.hx, f.z - base.hz) < CTF.cap) {
          scores[grab]++;
          events.push(['note', `${teamName(grab)} captured the flag!  ${scores[0]}–${scores[1]}`]);
          f.state = 'base'; f.x = f.hx; f.z = f.hz; f.carrier = null;
          if (scores[grab] >= CTF.target && sim.winner === null) { sim.winner = grab; events.push(['over', grab]); }
        }
        continue;
      }
      // at base or dropped: nearest enemy within reach grabs it
      let best = null, bd = CTF.pick * CTF.pick;
      for (const s of soldiers) {
        if (s.state !== 0 || s.unit.team !== grab) continue;
        const d = (s.x - f.x) ** 2 + (s.z - f.z) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      if (best) { f.carrier = best; f.state = 'carried'; events.push(['note', `${teamName(grab)} grabbed the ${teamName(f.team)} flag!`]); continue; }
      if (f.state === 'dropped') { // owner touch returns it; else auto-return
        f.dropT += dt;
        let ret = f.dropT > CTF.returnT;
        if (!ret) for (const s of soldiers) if (s.state === 0 && s.unit.team === f.team && (s.x - f.x) ** 2 + (s.z - f.z) ** 2 < CTF.pick * CTF.pick) { ret = true; break; }
        if (ret) { f.state = 'base'; f.x = f.hx; f.z = f.hz; events.push(['note', `${teamName(f.team)} flag returned`]); }
      }
    }
  }

  // ---- spatial grid ----
  let grid = new Map();
  const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  function rebuildGrid() {
    grid = new Map();
    for (const s of soldiers) {
      if (s.state !== 0) continue;
      const k = cellKey(s.x, s.z);
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(s);
    }
  }
  function forNeighbors(x, z, fn) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = grid.get(`${cx + i},${cz + j}`);
      if (a) for (const s of a) fn(s);
    }
  }
  function nearestEnemy(s, range) {
    let best = null, bd = range * range;
    forNeighbors(s.x, s.z, (o) => {
      if (o.unit.team === s.unit.team) return;
      const d = (o.x - s.x) ** 2 + (o.z - s.z) ** 2;
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }

  // ---- damage ----
  // imp (optional): the killing blow as a ragdoll launch { vx, vy, vz, spin }. Without
  // it, the corpse just crumples in place with a light topple — a sword kill shouldn't
  // fling a body like a boulder. Sources (boulder/explosion/charge) pass a real impulse.
  function kill(s, imp) {
    s.state = 1; s.deathT = 0;
    lastKill = sim.time; // stalemate detector
    s.unit.alive--;
    s.unit.morale = Math.max(0, s.unit.morale - 4);
    if (s.h >= 0) {
      soldierByHandle.delete(s.h);          // no longer a melee/boulder victim
      arena.remove(s.h);                    // drop the upright capsule
      let vx, vy, vz, spin;
      if (imp) { vx = imp.vx; vy = imp.vy; vz = imp.vz; spin = imp.spin; }
      else { // gentle crumple: small topple along the soldier's own facing
        const k = 0.8 + rng() * 0.7;
        vx = -Math.sin(s.face) * k + (rng() - 0.5); vy = 0.8 + rng() * 0.6;
        vz = -Math.cos(s.face) * k + (rng() - 0.5); spin = 1.2 + rng();
      }
      arena.spawnRagdoll(s.x, 1.0, s.z, vx, vy, vz, spin);
      s.h = -1;
    }
  }
  function damage(s, dmg, kind, imp) {
    if (s.state !== 0) return 0;
    const A = s.unit.type.alt;
    if (s.unit.stance && A) {
      const mult = kind === 'ranged' ? (A.rangedTaken ?? 1) : (A.meleeTaken ?? 1);
      if (mult < 1) {
        const st = kind === 'ranged' ? stats.blockRanged : stats.blockMelee;
        st.n++; st.dmg += dmg * (1 - mult);
        dmg *= mult;
      }
    }
    s.hp -= dmg;
    s.fightT = 0.5;
    if (s.hp <= 0) { kill(s, imp); return 1; }
    return 0;
  }
  function attack(s, target) {
    const T = s.unit.type;
    const charged = T.charge && s.mom > 8; // a cavalry charge lands a much harder blow
    let dmg = T.dmg + rng() * T.dmgVar;
    if (T.vsCav && target.unit.typeKey === 'cavalry') {
      const b = dmg * (T.vsCav - 1);
      dmg += b; stats.spearVsCav.n++; stats.spearVsCav.dmg += b;
    }
    if (T.charge && s.mom > 8) {
      const b = dmg * (T.charge - 1);
      dmg += b; stats.charge.n++; stats.charge.dmg += b;
      s.mom = 0;
      // physical impact: the victim is knocked flying and staggers back up
      if (target.h >= 0) {
        arena.impulse(target.h, Math.sin(s.face) * 18, 6, Math.cos(s.face) * 18);
        target.down = Math.max(target.down, 1.2);
      }
    }
    if (s.unit.stance && T.alt?.dmgMult && T.alt.dmgMult > 1) {
      const b = dmg * (T.alt.dmgMult - 1);
      dmg += b; stats.phalanxDmg.n++; stats.phalanxDmg.dmg += b;
    }
    s.fightT = 0.5;
    // ragdoll shove: a normal strike topples the victim gently away from the attacker;
    // a cavalry charge sends them flying
    const dx = target.x - s.x, dz = target.z - s.z, dd = Math.hypot(dx, dz) || 1;
    const f = charged ? 8 : 1.8 + rng() * 0.7;
    damage(target, dmg, 'melee', { vx: (dx / dd) * f, vy: 1 + f * 0.2, vz: (dz / dd) * f, spin: 1 + f * 0.5 });
  }

  function explode(x, z) {
    events.push(['boom', x, z]);
    forNeighbors(x, z, (s) => {
      const dx = s.x - x, dz = s.z - z, d = Math.hypot(dx, dz);
      if (d < CAT_AOE) {
        const f = 6 + 8 * (1 - d / CAT_AOE), dd = d || 1; // closer = flung harder, radially out
        stats.boulders.kills += damage(s, 120 * (1 - d / CAT_AOE), 'ranged',
          { vx: (dx / dd) * f, vy: 3 + f * 0.3, vz: (dz / dd) * f, spin: f * 0.7 });
      }
    });
  }

  // fire pot: a real radial-impulse explosion — soldiers, corpses, and rubble are
  // physically blasted outward (b3World_Explode); survivors are knocked down.
  const POT_R = 9, POT_DMG = 90;
  function fireBomb(x, z) {
    events.push(['firebomb', x, z]);
    stats.firepots++;
    arena.explode(x, 1.0, z, POT_R, 8);
    for (const s of soldiers) { // full scan: rare event, radius exceeds the grid reach
      if (s.state !== 0) continue;
      const dx = s.x - x, dz = s.z - z, d = Math.hypot(dx, dz);
      if (d >= POT_R) continue;
      const f = 8 + 12 * (1 - d / POT_R), dd = d || 1; // fire pot throws bodies hard, radially
      stats.boulders.kills += damage(s, POT_DMG * (1 - d / POT_R), 'ranged',
        { vx: (dx / dd) * f, vy: 4 + f * 0.35, vz: (dz / dd) * f, spin: f * 0.8 });
      if (s.state === 0) s.down = Math.max(s.down, 1 + rng());
    }
  }

  function enemyCentroid(team) {
    let x = 0, z = 0, n = 0;
    for (const s of soldiers) if (s.unit.team !== team && s.state === 0) { x += s.x; z += s.z; n++; }
    return n ? { x: x / n, z: z / n } : { x: 0, z: 0 };
  }

  // Desired-velocity intents written into the shared HEAP buffer; box3d integrates
  // them (and resolves collisions/separation) in arena.step. veff is capped so a
  // soldier never overshoots its target in one tick (mirrors the old min(d, v*dt)).
  function setVel(s, tx, tz, v, dt) {
    const it = arena.intents, o = s.h * 2;
    const dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz);
    if (d > 1e-6) { const veff = Math.min(v, d / dt); it[o] = (dx / d) * veff; it[o + 1] = (dz / d) * veff; }
    else { it[o] = 0; it[o + 1] = 0; }
  }
  function setStop(s) { const it = arena.intents, o = s.h * 2; it[o] = 0; it[o + 1] = 0; }

  // ---- orders (caller validates ownership) ----
  function order(unitIds, p0, p1) {
    const sel = unitIds.map((i) => units[i]).filter((u) => u && u.alive > 0 && !u.broken);
    if (!sel.length) return;
    const ec = enemyCentroid(sel[0].team);
    let dx = p1.x - p0.x, dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz);
    if (len < 3) {
      const facing = Math.atan2(ec.x - p0.x, ec.z - p0.z);
      const f = forward(facing);
      let totalW = 0;
      for (const u of sel) totalW += u.files * spacing(u) + 3;
      let off = -totalW / 2;
      for (const u of sel) {
        const w = u.files * spacing(u) + 3;
        const c = off + w / 2; off += w;
        u.ax = p0.x + f.z * c; u.az = p0.z - f.x * c;
        u.facing = facing;
      }
    } else {
      dx /= len; dz /= len;
      const mid = { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 };
      let px = dz, pz = -dx;
      if (px * (ec.x - mid.x) + pz * (ec.z - mid.z) < 0) { px = -px; pz = -pz; }
      const facing = Math.atan2(px, pz);
      sel.sort((a, b) => (a.ax * dx + a.az * dz) - (b.ax * dx + b.az * dz));
      const seg = len / sel.length;
      for (let i = 0; i < sel.length; i++) {
        const u = sel[i];
        if (u.typeKey !== 'catapult') u.files = clamp(Math.round(seg / spacing(u)), 3, u.n0);
        u.ax = p0.x + dx * seg * (i + 0.5);
        u.az = p0.z + dz * seg * (i + 0.5);
        u.facing = facing;
      }
    }
  }
  function toggleStance(unitIds) {
    for (const i of unitIds) {
      const u = units[i];
      if (u && u.type.alt && u.alive > 0 && !u.broken) {
        u.stance = u.stance ? 0 : 1;
        events.push(['note', `${teamName(u.team)} ${u.typeKey} ${u.stance ? 'formed ' + u.type.alt.name : 'broke ' + u.type.alt.name}`]);
      }
    }
  }
  function adjustFiles(unitIds, d) {
    for (const i of unitIds) {
      const u = units[i];
      if (u && u.alive > 0) u.files = clamp(u.files + d, 2, u.n0);
    }
  }

  // ---- main step ----
  let aiT = 0;
  const slotP = { x: 0, z: 0 };
  function step(dt) {
    sim.time += dt;
    rebuildGrid();

    // centroids
    for (const u of units) { u.sx = 0; u.sz = 0; }
    for (const s of soldiers) if (s.state === 0) { s.unit.sx += s.x; s.unit.sz += s.z; }
    for (const u of units) if (u.alive > 0) { u.cx = u.sx / u.alive; u.cz = u.sz / u.alive; }

    // refresh pathfinding periodically so wall breaches open new routes
    if (nav) { navT -= dt; if (navT <= 0) { navT = 1; recomputeNav(); } }
    // domination scoring at 1 Hz
    if (zones) { domT -= dt; if (domT <= 0) { domT = 1; domStep(); } }
    // fire barrages in flight
    if (strikes) strikeStep(dt);

    // Decide each soldier's desired velocity (+ melee) from last tick's positions,
    // writing intents into the shared buffer. box3d then integrates movement AND
    // resolves crowd separation / boundary in arena.step — no hand-rolled push-apart.
    for (const s of soldiers) {
      if (s.state === 1) { s.deathT += dt; if (s.deathT > CONFIG.ragdolls.lifetime) s.state = 2; continue; } // capsule already removed at kill; ragdoll pool owns the corpse
      if (s.state !== 0) continue;
      const u = s.unit, T = u.type;
      s.fightT = Math.max(0, s.fightT - dt);

      if (s.down > 0) { // knocked flying by an impact — sprawled, then gets back up
        s.down -= dt;
        setStop(s);
        continue;
      }

      if (u.garrison) { // battlement archers: hold the wall crest and rain arrows
        if (T.ranged) fireArrowMaybe(s, dt);
        s.face = u.facing;
        setStop(s);
        continue;
      }

      if (u.broken) { // rout: scatter out the NEAREST OPEN FLANK (around the city walls,
        // which sit on the backline) rather than piling into the home-city gate
        const ex = (s.x >= 0 ? 1 : -1) * (FIELD_W / 2);
        const ez = s.z + (u.team === 0 ? 1 : -1) * 25;
        setVel(s, ex, ez, s.speed * 1.15, dt);
        continue;
      }

      // CTF flag carrier ignores combat and sprints the enemy flag back to base
      if (ctf && flags[1 - u.team].carrier === s) {
        const home = flags[u.team];
        s.face = Math.atan2(home.hx - s.x, home.hz - s.z);
        setVel(s, home.hx, home.hz, s.speed * 1.1, dt);
        continue;
      }

      const speedMult = u.stance && T.alt ? T.alt.speedMult : 1;
      // Only AI-driven slots auto-assault along the siege flow field. A slot commanded
      // by a human or an LLM general (removed from sim.ai) OBEYS its orders — it forms
      // up at the ordered point and fights locally instead of being dragged to the wall.
      const commanded = !sim.ai.has(`${u.team}:${u.slot}`);
      const navUnit = nav && teamStance[u.team] === 'attack' && T !== TYPES.catapult && u.role !== 'guard' && !commanded;
      const enemy = nearestEnemy(s, SEEK_RANGE);
      const eDist = enemy ? Math.hypot(enemy.x - s.x, enemy.z - s.z) : Infinity;

      if (enemy && eDist <= T.range) {
        // in contact: fight (ranged units also melee when something's on top of them)
        s.face = Math.atan2(enemy.x - s.x, enemy.z - s.z);
        setStop(s);
        s.cd -= dt;
        if (s.cd <= 0) { s.cd = T.cd + rng() * ATTACK_CD_JIT; attack(s, enemy); }
      } else if (navUnit) {
        // ASSAULT: advance along the wall-routing flow field toward the enemy capital.
        // While the team is STAGING, hold a standoff ring outside the walls (facing
        // them, archers loosing) and let the artillery breach — then storm through.
        if (T.ranged) fireArrowMaybe(s, dt);
        const cap = caps && caps[1 - u.team];
        if (cap && assault[u.team] === 'stage') {
          const dc = Math.hypot(cap.cx - s.x, cap.cz - s.z);
          if (dc < cap.hs + 26) { s.face = Math.atan2(cap.cx - s.x, cap.cz - s.z); setStop(s); continue; }
        }
        const dir = nav[u.team].sample(s.x, s.z);
        if (dir) { s.face = Math.atan2(dir.x, dir.z); setVel(s, s.x + dir.x, s.z + dir.z, s.speed * speedMult, dt); }
        else if (enemy) { s.face = Math.atan2(enemy.x - s.x, enemy.z - s.z); setVel(s, enemy.x, enemy.z, s.speed * speedMult, dt); }
        else moveToSlot(s, u, speedMult, dt); // arrived at the objective — brawl in formation
      } else if (enemy) {
        // defenders / open field: engage the nearby enemy directly
        s.face = Math.atan2(enemy.x - s.x, enemy.z - s.z);
        if (u.stance && T.alt) { // phalanx/testudo holds ranks: advance as a block, never chase
          slotPos(u, s.slot, slotP);
          setVel(s, slotP.x, slotP.z, s.speed * speedMult, dt);
        } else setVel(s, enemy.x, enemy.z, s.speed * speedMult, dt);
      } else if (ctf) {
        // head for the enemy flag (its current position, even while carried by an ally)
        const ef = flags[1 - u.team];
        s.face = Math.atan2(ef.x - s.x, ef.z - s.z);
        setVel(s, ef.x, ef.z, s.speed * speedMult, dt);
      } else {
        // no enemy near: defenders hold their formed line in front of their own castle
        if (T.ranged) fireArrowMaybe(s, dt);
        moveToSlot(s, u, speedMult, dt);
      }
    }

    // Advance the physics world one tick, then read positions back. Momentum is
    // the ACTUAL distance moved per second (drives the cavalry charge bonus).
    arena.step(dt, SUBSTEPS);
    const xf = arena.transforms, ST = arena.XF_STRIDE;
    for (const s of soldiers) {
      if (s.state !== 0 || s.h < 0) continue;
      const o = s.h * ST, nx = xf[o], nz = xf[o + 2];
      s.mom = Math.hypot(nx - s.x, nz - s.z) / dt;
      s.x = nx; s.z = nz;
    }

    if (ctf) ctfStep(dt);

    // morale: regen when safe, pressure when depleted, break & rally
    for (const u of units) {
      if (u.alive <= 0) continue;
      let nearEnemy = false;
      for (const e of units) {
        if (e.team === u.team || e.alive <= 0) continue;
        if ((e.cx - u.cx) ** 2 + (e.cz - u.cz) ** 2 < 625) { nearEnemy = true; break; }
      }
      u.morale = Math.min(100, u.morale + (nearEnemy ? 1.5 : 8) * dt);
      if (u.alive < u.n0 * 0.35) u.morale = Math.max(0, u.morale - 8 * dt);
      if (!u.broken && u.morale < 20) {
        u.broken = true; stats.routs++;
        events.push(['note', `${teamName(u.team)} ${u.typeKey} is ROUTING!`]);
      } else if (u.broken && u.morale >= 60) {
        u.broken = false; stats.rallies++;
        u.ax = u.cx; u.az = u.cz;
        const ec = enemyCentroid(u.team);
        u.facing = Math.atan2(ec.x - u.cx, ec.z - u.cz);
        events.push(['note', `${teamName(u.team)} ${u.typeKey} rallied`]);
      }
      if (u.broken && (Math.abs(u.cx) > FIELD_W / 2 - 8 || Math.abs(u.cz) > FIELD_D / 2 - 8)) { // reached a perimeter
        for (const s of u.soldiers) if (s.state !== 2) s.state = 2;
        u.alive = 0;
        events.push(['note', `${teamName(u.team)} ${u.typeKey} fled the field`]);
      }
    }

    // catapults
    for (const u of units) {
      if (u.typeKey !== 'catapult' || u.alive <= 0 || u.broken) continue;
      u.catCd -= dt;
      if (u.catCd <= 0 && Math.hypot(u.cx - u.ax, u.cz - u.az) < 3) {
        // priority 1: bombard the enemy castle if it's in range (spread shots across
        // its footprint to smash walls). priority 2 (fort out of range): the army.
        let tx, tz, bd = 0;
        // nearest ENEMY castle to this catapult
        let efc = null, fd = Infinity;
        if (teamForts) for (const f of teamForts[1 - u.team]) { const d = Math.hypot(f.cx - u.ax, f.cz - u.az); if (d < fd) { fd = d; efc = f; } }
        if (efc && fd > CAT_MIN_RANGE && fd < CAT_RANGE) {
          tx = efc.cx + (rng() - 0.5) * 2 * efc.hs;
          tz = efc.cz + (rng() - 0.5) * 2 * efc.hs;
          bd = fd;
        } else {
          let best = null; bd = CAT_RANGE;
          for (const s of soldiers) {
            if (s.unit.team === u.team || s.state !== 0) continue;
            const d = Math.hypot(s.x - u.ax, s.z - u.az);
            if (d > CAT_MIN_RANGE && d < bd) { bd = d; best = s; }
          }
          if (best) { tx = best.x + (rng() - 0.5) * 6; tz = best.z + (rng() - 0.5) * 6; }
        }
        if (tx !== undefined) {
          u.catCd = CAT_CD;
          const dur = 1.2 + bd / 40;
          // launch a REAL rock on a ballistic arc that lands at (tx,0,tz) in `dur`s
          const vx = (tx - u.ax) / dur, vz = (tz - u.az) / dur;
          const vy = (0 - BOULDER_LAUNCH_Y) / dur + 0.5 * GRAVITY * dur;
          const h = arena.addBoulder(u.ax, BOULDER_LAUNCH_Y, u.az, vx, vy, vz, BOULDER_R);
          const vh = Math.hypot(vx, vz) || 1;
          boulders.push({ h, born: sim.time, hits: 0, fire: rng() < 0.35, dx: vx / vh, dz: vz / vh }); // ~1/3 are fire pots
          stats.boulders.fired++;
          events.push(['shot', u.ax, u.az, tx, tz, dur]); // cosmetic arc for the client
        }
      }
    }
    // siege engines: trebuchets whip their jointed arms at the nearest standing
    // enemy fort (half the shots are fire pots).
    if (engines) {
      const TREB_RANGE = 115, TREB_CD = 9, TREB_H = 4.5;
      for (const tb of engines.trebs) {
        tb.cd -= dt;
        const bh = arena.trebuchetPoll(tb.id); // boulder released mid-swing last tick?
        if (bh >= 0) { boulders.push({ h: bh, born: sim.time, hits: 0, fire: rng() < 0.5 }); stats.boulders.fired++; }
        if (tb.cd > 0) continue;
        let ef = null, fd = Infinity;
        for (const f of teamForts[1 - tb.team]) { const dd = Math.hypot(f.cx - tb.x, f.cz - tb.z); if (dd < fd) { fd = dd; ef = f; } }
        if (!ef || fd > TREB_RANGE) continue;
        tb.cd = TREB_CD;
        const tx = ef.cx + (rng() - 0.5) * 2 * ef.hs, tz = ef.cz + (rng() - 0.5) * 2 * ef.hs;
        const dur = 1.8 + fd / 35;
        arena.trebuchetFire(tb.id, (tx - tb.x) / dur, (0 - TREB_H) / dur + 0.5 * GRAVITY * dur, (tz - tb.z) / dur, 1.5);
      }
      // siege towers: roll toward the enemy capital along the flow field (so they route
      // around walls/houses instead of bulldozing through), then stop at the wall, drop
      // the drawbridge, and punch a breach the assault can pour through.
      const xfE = arena.transforms, STE = arena.XF_STRIDE;
      for (const tw of engines.towers) {
        if (tw.dropped) continue;
        const o = tw.h * STE, rx = xfE[o], rz = xfE[o + 2];
        let cap = null, cd = Infinity; // nearest enemy capital (skip solid towers)
        for (const f of teamForts[1 - tw.team]) if (!f.tower) { const dd = Math.hypot(f.cx - rx, f.cz - rz); if (dd < cd) { cd = dd; cap = f; } }
        if (cap && cd < cap.hs + 6) { // reached the wall: drop the bridge + tear a big breach
          arena.towerDrive(tw.id, 0, 0);
          arena.towerDrop(tw.id);
          arena.breach(rx + ((cap.cx - rx) / cd) * 5, 1, rz + ((cap.cz - rz) / cd) * 5, 11);
          assault[tw.team] = 'storm'; // the tower's breach sounds the assault immediately
          events.push(['note', `${teamName(tw.team)} siege tower breaches the wall — storm!`]);
          tw.dropped = true;
          continue;
        }
        const dir = nav[tw.team].sample(rx, rz);
        if (dir) arena.towerDrive(tw.id, dir.x * 4, dir.z * 4);
        else if (cap) arena.towerDrive(tw.id, ((cap.cx - rx) / cd) * 4, ((cap.cz - rz) / cd) * 4);
      }
    }
    // physics contacts: boulders plowing through crowds, fire pots detonating on
    // impact, and fast masonry rubble CRUSHING the soldiers it lands on.
    {
      const { count, pairs } = arena.contacts();
      const xf = arena.transforms, ST = arena.XF_STRIDE;
      const live = new Set(boulders.map((b) => b.h));
      for (let i = 0; i < count; i++) {
        const a = pairs[i * 2], b = pairs[i * 2 + 1];
        const ka = xf[a * ST + 7], kb = xf[b * ST + 7];
        if (ka === 6 || kb === 6) { // flying rubble vs soldier (speed-filtered in WASM)
          const rub = ka === 6 ? a : b;
          const victim = soldierByHandle.get(ka === 6 ? b : a);
          if (victim && victim.state === 0) {
            const dx = victim.x - xf[rub * ST], dz = victim.z - xf[rub * ST + 2], dd = Math.hypot(dx, dz) || 1;
            stats.crushed += damage(victim, 70 + rng() * 40, 'melee', // knocked aside + up by the falling stone
              { vx: (dx / dd) * 3, vy: 2 + rng(), vz: (dz / dd) * 3, spin: 4 + rng() * 2 });
            if (victim.state === 0) victim.down = Math.max(victim.down, 1.5);
          }
          continue;
        }
        let bh = -1, oh = -1;
        if (live.has(a)) { bh = a; oh = b; } else if (live.has(b)) { bh = b; oh = a; }
        if (bh < 0) continue;
        const bl = boulders.find((x) => x.h === bh);
        const victim = soldierByHandle.get(oh);
        if (victim) { // a rolling rock bowls bodies along its path and up into the air
          const f = 15;
          stats.boulders.kills += damage(victim, BOULDER_DMG, 'ranged',
            { vx: (bl?.dx ?? 0) * f, vy: 5, vz: (bl?.dz ?? 0) * f, spin: 9 });
          bl.hits++;
        }
        else { // hit terrain, wall, or rubble — detonate/splash at the rock (walls breach in WASM)
          const k = xf[oh * ST + 7];
          if (k === 4 || k === 2 || k === 6) {
            if (bl && bl.fire) fireBomb(xf[bh * ST], xf[bh * ST + 2]);
            else explode(xf[bh * ST], xf[bh * ST + 2]);
            if (bl) bl.born = -1e9; // mark spent
          }
        }
      }
      for (let i = boulders.length - 1; i >= 0; i--) {
        if (sim.time - boulders[i].born > BOULDER_LIFE) { arena.remove(boulders[i].h); boulders.splice(i, 1); }
      }
    }
    // arrows: cosmetic timers in JS, but the hit is resolved by a vertical ray at
    // the landing column so real geometry (walls) can block and the true soldier is picked.
    for (let i = arrows.length - 1; i >= 0; i--) {
      const a = arrows[i];
      a.t += dt;
      if (a.t >= a.dur) {
        // vertical ray picks the exact soldier under the impact (and lets real
        // geometry occlude); fall back to nearest-in-radius so a near miss in a
        // dense formation still lands, preserving archer effectiveness.
        const hh = arena.raycast(a.tx, 20, a.tz, a.tx, -1, a.tz);
        let hit = soldierByHandle.get(hh);
        if (!hit || hit.state !== 0) {
          let bd = 1.2;
          forNeighbors(a.tx, a.tz, (s) => {
            const d = Math.hypot(s.x - a.tx, s.z - a.tz);
            if (d < bd) { bd = d; hit = s; }
          });
        }
        if (hit && hit.state === 0) { // a light backward stagger along the arrow's flight
          damage(hit, a.dmg, 'ranged', { vx: a.dx * 2, vy: 1.2, vz: a.dz * 2, spin: 1.5 });
          stats.arrows.hits++;
        }
        arrows.splice(i, 1);
      }
    }

    // AI for unowned slots
    aiT -= dt;
    if (aiT <= 0) {
      aiT = 2;
      // wrath of the gods: AI-run teams drop their barrage on the densest enemy unit
      if (strikes) for (let t = 0; t < 2; t++) {
        if (sim.time < strikes.ready[t]) continue;
        let hasAI = false;
        for (const k of sim.ai) if (k.startsWith(`${t}:`)) { hasAI = true; break; }
        if (!hasAI) continue;
        let best = null, bn = 14; // only worth it on a real formation
        for (const e of units) if (e.team !== t && !e.garrison && e.alive > bn) { bn = e.alive; best = e; }
        if (best) sim.strike(t, best.cx, best.cz);
      }
      for (const u of units) {
        if (u.alive <= 0 || u.broken || u.garrison) continue; // garrisons never leave their wall
        if (!sim.ai.has(`${u.team}:${u.slot}`)) continue;
        if (u.typeKey === 'catapult') { // creep into range if nothing to shoot
          let best = null, bd = Infinity;
          for (const e of units) {
            if (e.team === u.team || e.alive <= 0) continue;
            const d = Math.hypot(e.cx - u.cx, e.cz - u.cz);
            if (d < bd) { bd = d; best = e; }
          }
          if (best && bd > CAT_RANGE * 0.8) {
            const facing = Math.atan2(best.cx - u.cx, best.cz - u.cz);
            const f = forward(facing);
            u.ax = best.cx - f.x * CAT_RANGE * 0.7; u.az = best.cz - f.z * CAT_RANGE * 0.7;
            u.facing = facing;
          }
          continue;
        }
        // home guard: hold the line in front of our own city — engage only enemies
        // that come near home, otherwise keep formation on the home anchor.
        if (u.role === 'guard') {
          let best = null, bd = 55 * 55;
          for (const e of units) {
            if (e.team === u.team || e.alive <= 0) continue;
            const d = (e.cx - u.homeX) ** 2 + (e.cz - u.homeZ) ** 2;
            if (d < bd) { bd = d; best = e; }
          }
          if (best) { u.ax = best.cx; u.az = best.cz; u.facing = Math.atan2(best.cx - u.cx, best.cz - u.cz); }
          else { u.ax = u.homeX; u.az = u.homeZ; u.facing = u.team === 0 ? Math.PI : 0; }
          continue;
        }
        // domination: melee units march on the nearest zone we don't hold; combat
        // still takes over locally via per-soldier seek once enemies are close.
        if (zones && !u.type.ranged) {
          let zb = null, zd = Infinity;
          for (const z of zones) {
            if (z.holder === u.team) continue;
            const d = (z.x - u.cx) ** 2 + (z.z - u.cz) ** 2;
            if (d < zd) { zd = d; zb = z; }
          }
          if (zb) {
            u.ax = zb.x + (rng() - 0.5) * 10; u.az = zb.z + (rng() - 0.5) * 10;
            u.facing = Math.atan2(zb.x - u.cx, zb.z - u.cz);
            continue;
          }
        }
        let best = null, bd = Infinity;
        for (const e of units) {
          if (e.team === u.team || e.alive <= 0) continue;
          const pref = u.typeKey === 'cavalry' && e.typeKey === 'archer' ? 0.5 : 1;
          const d = ((e.cx - u.cx) ** 2 + (e.cz - u.cz) ** 2) * pref;
          if (d < bd) { bd = d; best = e; }
        }
        if (!best) continue;
        const d = Math.hypot(best.cx - u.cx, best.cz - u.cz);
        const facing = Math.atan2(best.cx - u.cx, best.cz - u.cz);
        if (u.type.ranged) { // archers hold at standoff range
          if (d > 38) {
            const f = forward(facing);
            u.ax = best.cx - f.x * 36; u.az = best.cz - f.z * 36; u.facing = facing;
          } else u.facing = facing;
        } else {
          u.ax = best.cx; u.az = best.cz; u.facing = facing;
          // pikes lower up close; legions only testudo against missiles (it stalls melee)
          const want = d < 30 && (u.typeKey === 'pike' || !!best.type.ranged || best.typeKey === 'catapult');
          if (u.type.alt && !!u.stance !== want) toggleStance([u.id]);
        }
      }
    }

    // winner: annihilation, or a STALEMATE call — e.g. only unreachable wall
    // garrisons left, or both sides too depleted to close. If nobody has died for
    // 25s late in the battle, the side with more survivors (morale tiebreak) wins.
    const counts = [0, 0], mobile = [0, 0];
    for (const s of soldiers) if (s.state === 0) {
      counts[s.unit.team]++;
      if (!s.unit.garrison && !s.unit.broken) mobile[s.unit.team]++; // can still fight/advance
    }
    sim.counts = counts;
    const decide = (w, msg) => { sim.winner = w; if (msg) events.push(['note', msg]); events.push(['over', w]); };
    const byField = () => { // more survivors, morale as tiebreak
      if (counts[0] !== counts[1]) return counts[0] > counts[1] ? 0 : 1;
      const m = [0, 0];
      for (const u of units) if (u.alive > 0) m[u.team] += u.morale;
      return m[0] >= m[1] ? 0 : 1;
    };
    if (sim.winner === null) {
      if (counts[0] === 0 || counts[1] === 0) decide(counts[0] === 0 ? 1 : 0);        // annihilated
      else if (mobile[0] === 0 || mobile[1] === 0)                                     // only wall garrisons/routers left — can't win
        decide(mobile[0] === 0 ? 1 : 0, `${teamName(mobile[0] === 0 ? 1 : 0)} breaks the siege — no army left to oppose them!`);
      else if (sim.time > 60 && sim.time - lastKill > 20) decide(byField(), `Stalemate — ${teamName(byField())} holds the field!`); // lull
      else if (sim.time > 300) decide(byField(), `Time — ${teamName(byField())} holds the field!`);                                  // hard cap
    }
  }

  function fireArrowMaybe(s, dt) {
    const R = s.unit.type.ranged;
    s.cdR -= dt;
    if (s.cdR > 0) return;
    let best = null, bd = R.range;
    for (const e of units) {
      if (e.team === s.unit.team || e.alive <= 0) continue;
      const d = Math.hypot(e.cx - s.x, e.cz - s.z);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return;
    const alive = best.soldiers.filter((t) => t.state === 0);
    const t = alive[Math.floor(rng() * alive.length)];
    if (!t) return;
    s.cdR = R.cd * (0.8 + rng() * 0.4);
    const tx = t.x + (rng() - 0.5) * 4, tz = t.z + (rng() - 0.5) * 4;
    const fl = Math.hypot(tx - s.x, tz - s.z) || 1;
    const dur = 0.4 + fl / 28;
    arrows.push({ tx, tz, t: 0, dur, dmg: R.dmg + rng() * R.dmgVar, dx: (tx - s.x) / fl, dz: (tz - s.z) / fl });
    stats.arrows.fired++;
    s.face = Math.atan2(tx - s.x, tz - s.z);
    events.push(['arrow', s.x, s.z, tx, tz, dur]);
  }

  return sim;
}
