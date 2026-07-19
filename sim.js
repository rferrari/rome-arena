// Pure battle simulation — no three.js, no DOM. Runs on the server (bun)
// and in the browser (solo fallback). Server-authoritative: clients only
// send orders, so there is no lockstep desync class of bugs.

import { CONFIG } from './physics/config.js';
import { createFlowField } from './physics/flowfield.js';

export const FIELD_W = 200, FIELD_D = 140;
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

export function createSim({ seed = 1, players = [2, 2], arena, fort = false, ctf = false } = {}) {
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

  // count: explicit for CTF squads; otherwise scaled by the tier's unitScale
  function makeUnit(team, slot, typeKey, ax, az, facing, count) {
    const type = TYPES[typeKey];
    const n = count ?? (typeKey === 'catapult' ? type.n : Math.max(4, Math.round(type.n * (CONFIG.unitScale || 1))));
    const u = {
      id: units.length, team, slot, typeKey, type, n0: n,
      ax, az, facing, files: Math.min(type.files, n), stance: 0,
      morale: 100, broken: false, alive: n,
      cx: ax, cz: az, catCd: CAT_CD * rng(), soldiers: [],
    };
    const p = { x: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      slotPos(u, i, p);
      const s = {
        id: soldiers.length, unit: u, slot: i,
        x: p.x, z: p.z, face: facing, hp: type.hp,
        cd: rng(), cdR: rng() * 2, state: 0 /* 0 alive 1 dying 2 gone */,
        deathT: 0, fightT: 0, mom: 0,
        speed: type.speed * (0.9 + rng() * 0.2),
        h: arena.addSoldier(p.x, p.z), // box3d capsule body handle
      };
      u.soldiers.push(s); soldiers.push(s); soldierByHandle.set(s.h, s);
    }
    units.push(u);
    return u;
  }

  // ---- capture the flag: small squads + a flag at each team's base ----
  let flags = null, scores = null;
  const CTF = { pick: 2.6, cap: 4.0, target: 3, baseZ: 60, returnT: 15 };
  if (ctf) {
    // small readable squads: fast cavalry runners + a legion escort per player slot
    const COMP_CTF = [['cavalry', 8], ['legion', 12]];
    for (let team = 0; team < 2; team++) {
      const dir = team === 0 ? 1 : -1, facing = team === 0 ? Math.PI : 0;
      const blockW = Math.min(30, (FIELD_W - 10) / players[team]);
      for (let p = 0; p < players[team]; p++) {
        const bx = (p + 0.5 - players[team] / 2) * blockW;
        COMP_CTF.forEach(([t, cnt], i) =>
          makeUnit(team, p, t, bx + (i - (COMP_CTF.length - 1) / 2) * 8, dir * 44, facing, cnt));
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
  const zM = fort ? 26 : 42, zB = fort ? 34 : 52, zC = fort ? 42 : 60;
  const nCat = fort ? 3 : 1; // a battery of catapults in siege mode
  for (let team = 0; team < 2; team++) {
    const dir = team === 0 ? 1 : -1, facing = team === 0 ? Math.PI : 0;
    const blockW = Math.min(46, (FIELD_W - 10) / players[team]);
    for (let p = 0; p < players[team]; p++) {
      const bx = (p + 0.5 - players[team] / 2) * blockW;
      COMP_FRONT.forEach((t, i) =>
        makeUnit(team, p, t, bx + (i + 0.5 - COMP_FRONT.length / 2) * (blockW / COMP_FRONT.length), dir * zM, facing));
      COMP_BACK.forEach((t, i) =>
        makeUnit(team, p, t, bx + (i + 0.5 - COMP_BACK.length / 2) * (blockW / COMP_BACK.length), dir * zB, facing));
      for (let k = 0; k < nCat; k++) makeUnit(team, p, 'catapult', bx + (k - (nCat - 1) / 2) * 7, dir * zC, facing);
      sim.ai.add(`${team}:${p}`); // owners claim their slot; unclaimed = AI
    }
  }
  }

  // THREE castles per team in a triangle at its backline, gates facing the enemy.
  // Each team's stance decides whether it holds its own forts ('defend') or storms
  // the enemy's ('attack', pathing to the NEAREST enemy castle via a flow field).
  // Default off so open-field test_sim is unaffected.
  let nav = null, teamForts = null, teamStance = null, navT = 0;
  if (fort) {
    const F = CONFIG.fort, hs = F.halfSize, bz = F.backZ;
    teamStance = F.stance;
    // three castles in a row along each team's backline (behind its army), gates
    // facing the enemy; kept clear of the deployment zone so nothing spawns inside.
    const layout = (dir) => [-48, 0, 48].map((cx) => ({ cx, cz: dir * bz, gd: -dir }));
    teamForts = [layout(1), layout(-1)];
    for (let t = 0; t < 2; t++) for (const f of teamForts[t]) arena.buildFort(f.cx, f.cz, hs, F.courses, f.gd);
    arena.sync();
    nav = [createFlowField(FIELD_W, FIELD_D, F.navCell), createFlowField(FIELD_W, FIELD_D, F.navCell)];
    sim.teamForts = teamForts;
    recomputeNav();
  }

  // nav[t] = flow field for team t's attackers toward EVERY enemy castle (multi-source,
  // so each cell points to the nearest one). Blocks standing walls; breached rubble
  // (kind 6) opens a path. Recomputed periodically so breaches reroute the assault.
  function recomputeNav() {
    const xf = arena.transforms, ST = arena.XF_STRIDE, n = arena.count, hs = CONFIG.fort.halfSize;
    for (let t = 0; t < 2; t++) {
      nav[t].clearBlocked();
      for (let h = 0; h < n; h++) { const b = h * ST; if (xf[b + 7] === 2) nav[t].blockWorld(xf[b], xf[b + 2]); }
      const goals = teamForts[1 - t].map((f) => ({ x: f.cx, z: f.cz - (f.cz >= 0 ? 1 : -1) * (hs - 2) })); // just inside each gate
      nav[t].compute(goals);
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
  function kill(s) {
    s.state = 1; s.deathT = 0;
    s.unit.alive--;
    s.unit.morale = Math.max(0, s.unit.morale - 4);
    if (s.h >= 0) {
      soldierByHandle.delete(s.h);          // no longer a melee/boulder victim
      arena.remove(s.h);                    // drop the upright capsule
      // spawn a jointed ragdoll flung backward from the soldier's facing (pooled/capped)
      const k = 3 + rng() * 3;
      arena.spawnRagdoll(s.x, 1.0, s.z, -Math.sin(s.face) * k + (rng() - 0.5) * 3,
                         3 + rng() * 2, -Math.cos(s.face) * k + (rng() - 0.5) * 3);
      s.h = -1;
    }
  }
  function damage(s, dmg, kind) {
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
    if (s.hp <= 0) { kill(s); return 1; }
    return 0;
  }
  function attack(s, target) {
    const T = s.unit.type;
    let dmg = T.dmg + rng() * T.dmgVar;
    if (T.vsCav && target.unit.typeKey === 'cavalry') {
      const b = dmg * (T.vsCav - 1);
      dmg += b; stats.spearVsCav.n++; stats.spearVsCav.dmg += b;
    }
    if (T.charge && s.mom > 8) {
      const b = dmg * (T.charge - 1);
      dmg += b; stats.charge.n++; stats.charge.dmg += b;
      s.mom = 0;
    }
    if (s.unit.stance && T.alt?.dmgMult && T.alt.dmgMult > 1) {
      const b = dmg * (T.alt.dmgMult - 1);
      dmg += b; stats.phalanxDmg.n++; stats.phalanxDmg.dmg += b;
    }
    s.fightT = 0.5;
    damage(target, dmg, 'melee');
  }

  function explode(x, z) {
    events.push(['boom', x, z]);
    forNeighbors(x, z, (s) => {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < CAT_AOE) stats.boulders.kills += damage(s, 120 * (1 - d / CAT_AOE), 'ranged');
    });
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

    // Decide each soldier's desired velocity (+ melee) from last tick's positions,
    // writing intents into the shared buffer. box3d then integrates movement AND
    // resolves crowd separation / boundary in arena.step — no hand-rolled push-apart.
    for (const s of soldiers) {
      if (s.state === 1) { s.deathT += dt; if (s.deathT > CONFIG.ragdolls.lifetime) s.state = 2; continue; } // capsule already removed at kill; ragdoll pool owns the corpse
      if (s.state !== 0) continue;
      const u = s.unit, T = u.type;
      s.fightT = Math.max(0, s.fightT - dt);

      if (u.broken) { // rout: run for your own map edge (piles at the wall, then flees)
        setVel(s, s.x, u.team === 0 ? FIELD_D : -FIELD_D, s.speed * 1.15, dt);
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
      const enemy = nearestEnemy(s, SEEK_RANGE);
      if (enemy) {
        const d = Math.hypot(enemy.x - s.x, enemy.z - s.z);
        s.face = Math.atan2(enemy.x - s.x, enemy.z - s.z);
        if (d <= T.range) {
          setStop(s);
          s.cd -= dt;
          if (s.cd <= 0) { s.cd = T.cd + rng() * ATTACK_CD_JIT; attack(s, enemy); }
        } else if (u.stance && T.alt) {
          // phalanx/testudo holds ranks: advance as a block, never chase
          slotPos(u, s.slot, slotP);
          setVel(s, slotP.x, slotP.z, s.speed * speedMult, dt);
        } else setVel(s, enemy.x, enemy.z, s.speed * speedMult, dt);
      } else if (ctf) {
        // head for the enemy flag (its current position, even while carried by an ally)
        const ef = flags[1 - u.team];
        s.face = Math.atan2(ef.x - s.x, ef.z - s.z);
        setVel(s, ef.x, ef.z, s.speed * speedMult, dt);
      } else {
        if (T.ranged) fireArrowMaybe(s, dt);
        // No enemy nearby: only an ATTACKING team marches (flow field, around walls
        // and through the gate, toward the enemy fort). Defenders hold their formed
        // line in front of their own castle rather than piling inside it.
        if (nav && teamStance[u.team] === 'attack' && T !== TYPES.catapult) {
          const dir = nav[u.team].sample(s.x, s.z); // this team's field toward the enemy castles
          if (dir) { s.face = Math.atan2(dir.x, dir.z); setVel(s, s.x + dir.x, s.z + dir.z, s.speed * speedMult, dt); }
          else moveToSlot(s, u, speedMult, dt); // reached the objective — brawl in formation
        } else moveToSlot(s, u, speedMult, dt);
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
      if (u.broken && Math.abs(u.cz) > FIELD_D / 2 - 8) { // reached the perimeter wall
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
          const hs = CONFIG.fort.halfSize;
          tx = efc.cx + (rng() - 0.5) * 2 * hs;
          tz = efc.cz + (rng() - 0.5) * 2 * hs;
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
          boulders.push({ h, born: sim.time, hits: 0 });
          stats.boulders.fired++;
          events.push(['shot', u.ax, u.az, tx, tz, dur]); // cosmetic arc for the client
        }
      }
    }
    // boulder damage: real rocks plow through crowds — each begin-touch with a
    // soldier is a hit; hitting terrain/wall detonates an AoE splash at the rock.
    if (boulders.length) {
      const { count, pairs } = arena.contacts();
      const xf = arena.transforms, ST = arena.XF_STRIDE;
      const live = new Set(boulders.map((b) => b.h));
      for (let i = 0; i < count; i++) {
        const a = pairs[i * 2], b = pairs[i * 2 + 1];
        let bh = -1, oh = -1;
        if (live.has(a)) { bh = a; oh = b; } else if (live.has(b)) { bh = b; oh = a; }
        if (bh < 0) continue;
        const victim = soldierByHandle.get(oh);
        if (victim) { stats.boulders.kills += damage(victim, BOULDER_DMG, 'ranged'); boulders.find((x) => x.h === bh).hits++; }
        else { // hit terrain, wall, or rubble — splash at the rock (walls breach in WASM)
          const k = xf[oh * ST + 7];
          if (k === 4 || k === 2 || k === 6) {
            explode(xf[bh * ST], xf[bh * ST + 2]);
            const bl = boulders.find((x) => x.h === bh); if (bl) bl.born = -1e9; // mark spent
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
        if (hit && hit.state === 0) { damage(hit, a.dmg, 'ranged'); stats.arrows.hits++; }
        arrows.splice(i, 1);
      }
    }

    // AI for unowned slots
    aiT -= dt;
    if (aiT <= 0) {
      aiT = 2;
      for (const u of units) {
        if (u.alive <= 0 || u.broken) continue;
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

    // winner
    const counts = [0, 0];
    for (const s of soldiers) if (s.state === 0) counts[s.unit.team]++;
    sim.counts = counts;
    if (sim.winner === null && (counts[0] === 0 || counts[1] === 0)) {
      sim.winner = counts[0] === 0 ? 1 : 0;
      events.push(['over', sim.winner]);
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
    const dur = 0.4 + Math.hypot(tx - s.x, tz - s.z) / 28;
    arrows.push({ tx, tz, t: 0, dur, dmg: R.dmg + rng() * R.dmgVar });
    stats.arrows.fired++;
    s.face = Math.atan2(tx - s.x, tz - s.z);
    events.push(['arrow', s.x, s.z, tx, tz, dur]);
  }

  return sim;
}
