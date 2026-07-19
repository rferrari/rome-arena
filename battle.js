// Client: renderer + input + WebSocket client. The sim runs on the server
// (server.js); if no server responds we fall back to a local solo sim vs AI
// using the exact same sim.js module.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSim, TYPES, FIELD_W, FIELD_D, SPACING } from './sim.js';
import { createArena } from './physics/arena_api.js';
import { CONFIG } from './physics/config.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------- scene ----------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2028);
scene.fog = new THREE.Fog(0x1a2028, 180, 380);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 600);
// Prefer the discrete (NVIDIA) GPU, but fall back gracefully if the driver rejects
// that context attribute or WebGL2 is blocked (hardware accel off).
function makeRenderer() {
  for (const attrs of [{ antialias: true, powerPreference: 'high-performance' }, { antialias: true }, {}]) {
    try { return new THREE.WebGLRenderer(attrs); } catch (e) { console.warn('WebGL attempt failed:', attrs, e.message); }
  }
  document.body.innerHTML = '<div style="color:#eee;font-family:system-ui;padding:24px;line-height:1.6">' +
    '<h2>WebGL2 unavailable</h2>Enable hardware acceleration in your browser and check <b>chrome://gpu</b>.<br>' +
    'On Linux/Optimus, launching Chrome with the NVIDIA PRIME env vars can also fix (or, if it breaks it, remove) this.</div>';
  throw new Error('WebGL2 context could not be created');
}
const renderer = makeRenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xcfd8e6, 0x3a3526, 1.1));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
sun.position.set(60, 100, 40);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(FIELD_W, FIELD_D),
  new THREE.MeshStandardMaterial({ color: 0x5d6b45, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const mid = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, 0.5), new THREE.MeshBasicMaterial({ color: 0x707d55 }));
mid.rotation.x = -Math.PI / 2;
mid.position.y = 0.02;
scene.add(mid);

const TEAM_COLORS = [new THREE.Color(0xd23c3c), new THREE.Color(0x3c64d2)];
const DEAD_COLOR = new THREE.Color(0x4a4a4a);
const WHITE = new THREE.Color(0xffffff);

// ---------------- model (filled by init) ----------------
// meta.units[j] = {id, team, slot, type, n, start} ; soldiers implied in order
const meta = { units: [], nS: 0 };
let mode = null;      // 'net' | 'solo'
let phase = 'lobby';  // 'lobby' | 'playing'
let you = null;       // {team, slot} | {spectator}
let sim = null;       // solo only
let ws = null;
let winner = null;
let statsData = null, countsData = [0, 0];

// per-frame read adapters, set once per mode
let readSoldier = null, readUnit = null;

function buildMeta(unitList) {
  meta.units = [];
  let start = 0;
  for (const u of unitList) {
    meta.units.push({ ...u, start });
    start += u.n;
  }
  meta.nS = start;
  // reset per-battle state (also handles rematch)
  snaps.length = 0;
  dieTime.clear();
  selected.clear();
  flyingArrows.length = 0;
  for (const p of flyingStones) { p.mesh.visible = false; stonePool.push(p.mesh); }
  flyingStones.length = 0;
  winner = null;
  ended = false;
  banner.style.display = 'none';
  buildRenderers();
}
const soldierUnitIdx = []; // i -> unit index, filled in buildRenderers

// ---------------- net / solo bootstrap ----------------
const snaps = []; // {t, x, z, face, flags, units:[{ax,az,morale,files,flags}]}
const dieTime = new Map();
const INTERP_DELAY = 150;

function decodeSnapshot(buf) {
  const v = new DataView(buf);
  const nS = meta.nS, nU = meta.units.length;
  const s = {
    t: performance.now(),
    x: new Float32Array(nS), z: new Float32Array(nS),
    face: new Uint8Array(nS), flags: new Uint8Array(nS), units: [],
  };
  let o = 5;
  for (let i = 0; i < nS; i++) {
    s.x[i] = v.getInt16(o, true) / 100;
    s.z[i] = v.getInt16(o + 2, true) / 100;
    s.face[i] = v.getUint8(o + 4);
    s.flags[i] = v.getUint8(o + 5);
    o += 6;
  }
  for (let j = 0; j < nU; j++) {
    s.units.push({
      ax: v.getInt16(o, true) / 100, az: v.getInt16(o + 2, true) / 100,
      morale: v.getUint8(o + 4), files: v.getUint8(o + 5), flags: v.getUint8(o + 6),
    });
    o += 7;
  }
  // props (fort bricks + ragdoll corpses) — full 3D transforms, rendered from the
  // latest snapshot without interpolation (they move fast when hit).
  const nP = v.getUint16(o, true); o += 2;
  const props = new Float32Array(nP * 11); // x,y,z, qx,qy,qz,qw, hx,hy,hz, kind
  for (let i = 0; i < nP; i++) {
    const p = i * 11;
    props[p] = v.getInt16(o, true) / 100;
    props[p + 1] = v.getInt16(o + 2, true) / 100;
    props[p + 2] = v.getInt16(o + 4, true) / 100;
    props[p + 3] = v.getInt16(o + 6, true) / 32767;
    props[p + 4] = v.getInt16(o + 8, true) / 32767;
    props[p + 5] = v.getInt16(o + 10, true) / 32767;
    props[p + 6] = v.getInt16(o + 12, true) / 32767;
    props[p + 7] = v.getUint8(o + 14) / 50;
    props[p + 8] = v.getUint8(o + 15) / 50;
    props[p + 9] = v.getUint8(o + 16) / 50;
    props[p + 10] = v.getUint8(o + 17);
    o += 18;
  }
  s.props = props; s.nProps = nP;
  snaps.push(s);
  if (snaps.length > 12) snaps.shift();
}

function setupNetReaders() {
  const out2PI = Math.PI * 2;
  readSoldier = (i, out) => {
    const n = snaps.length;
    if (!n) return false;
    const rt = performance.now() - INTERP_DELAY;
    let a = snaps[0], b = snaps[n - 1];
    for (let k = n - 1; k > 0; k--) {
      if (snaps[k - 1].t <= rt) { a = snaps[k - 1]; b = snaps[k]; break; }
    }
    const al = clamp((rt - a.t) / Math.max(1, b.t - a.t), 0, 1);
    out.x = a.x[i] + (b.x[i] - a.x[i]) * al;
    out.z = a.z[i] + (b.z[i] - a.z[i]) * al;
    const df = ((b.face[i] - a.face[i] + 384) % 256) - 128;
    out.face = ((a.face[i] + df * al) / 255) * out2PI;
    const f = b.flags[i];
    out.state = f & 3;
    out.fighting = !!(f & 4);
    out.broken = !!(f & 8);
    out.stance = !!(f & 16);
    out.down = !!(f & 32);
    if (out.state === 1 && !dieTime.has(i)) dieTime.set(i, performance.now());
    out.deathT = out.state === 1 ? (performance.now() - (dieTime.get(i) ?? performance.now())) / 1000 : 0;
    return true;
  };
  readUnit = (j) => {
    const s = snaps[snaps.length - 1];
    if (!s) return null;
    const d = s.units[j];
    return {
      ax: d.ax, az: d.az, morale: d.morale, files: d.files,
      broken: !!(d.flags & 1), stance: !!(d.flags & 2), alive: !!(d.flags & 4),
    };
  };
}

function setupSoloReaders() {
  readSoldier = (i, out) => {
    const s = sim.soldiers[i];
    out.x = s.x; out.z = s.z; out.face = s.face;
    out.state = s.state; out.fighting = s.fightT > 0;
    out.broken = s.unit.broken; out.stance = !!s.unit.stance;
    out.down = s.down > 0;
    out.deathT = s.deathT;
    return true;
  };
  readUnit = (j) => {
    const u = sim.units[j];
    return { ax: u.ax, az: u.az, morale: u.morale, files: u.files, broken: u.broken, stance: !!u.stance, alive: u.alive > 0 };
  };
}

let booting = false;
async function startSolo() {
  if (booting || mode) return; // async WASM load leaves `mode` null; guard re-entry
  booting = true;
  const arena = await createArena({ maxBodies: CONFIG.maxBodies }); // browser-side box3d world for solo play
  mode = 'solo';
  you = { team: 0, slot: -1 }; // -1 = owns all of team 0
  sim = createSim({ seed: (Math.random() * 1e9) | 0, players: [2, 2], arena, fort: location.hash.includes('fort'), dom: location.hash.includes('dom'), ctf: location.hash.includes('ctf') });
  for (let p = 0; p < 2; p++) sim.ai.delete(`0:${p}`);
  buildMeta(sim.units.map((u) => ({ id: u.id, team: u.team, slot: u.slot, type: u.typeKey, n: u.n0 })));
  setupSoloReaders();
  showLobby([
    { team: 0, slot: 0, human: true }, { team: 0, slot: 1, human: true },
    { team: 1, slot: 0, human: false }, { team: 1, slot: 1, human: false },
  ]);
}

function connect() {
  if (location.protocol === 'file:') return startSolo();
  ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  const fallback = setTimeout(() => { try { ws.close(); } catch {} if (!mode) startSolo(); }, 1500);
  ws.onerror = () => { clearTimeout(fallback); if (!mode) startSolo(); };
  ws.onclose = () => { if (!mode) startSolo(); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'init') {
        clearTimeout(fallback);
        mode = 'net';
        you = m.you;
        if (m.render) renderer.setPixelRatio(Math.min(devicePixelRatio, m.render.pixelRatio || 2));
        buildMeta(m.units);
        setupNetReaders();
        phase = m.state;
        if (you.team === 1) { viewDir = -1; camTarget.z = -35; }
      } else if (m.type === 'lobby') {
        phase = m.state;
        if (phase === 'lobby') showLobby(m.roster);
      } else if (m.type === 'start') {
        phase = 'playing';
        lobbyEl.style.display = 'none';
      } else if (m.type === 'ev') {
        for (const ev of m.e) handleEvent(ev);
        statsData = m.stats; countsData = m.counts || countsData;
        if (m.flags) flagsData = m.flags;
        if (m.scores) scoresData = m.scores;
        if (m.zones) zonesData = m.zones;
        if (m.tickets) ticketsData = m.tickets;
        if (m.winner !== null && m.winner !== undefined) winner = m.winner;
      }
    } else if (mode === 'net') decodeSnapshot(e.data);
  };
}
function sendCmd(cmd) {
  if (mode === 'net') ws.send(JSON.stringify(cmd));
  else if (cmd.type === 'order') sim.order(cmd.unitIds, { x: cmd.p0[0], z: cmd.p0[1] }, { x: cmd.p1[0], z: cmd.p1[1] });
  else if (cmd.type === 'stance') sim.toggleStance(cmd.unitIds);
  else if (cmd.type === 'files') sim.adjustFiles(cmd.unitIds, cmd.d);
}

// ---------------- rendering pools (built after init) ----------------
const dummy = new THREE.Object3D();
dummy.rotation.order = 'YXZ';
const catMeshes = new Map(); // unit idx -> group
const colorKey = [];

// Living soldiers are little articulated humanoids built from instanced capsule
// parts (torso, head, 2 arms, 2 legs) with procedural walk/attack — GPU-instanced
// so the whole army stays cheap. Same capsule look as the death ragdoll.
let hTorso = null, hHead = null, hArm = null, hLeg = null;
const walkPhase = [];      // per soldier gait phase
const soPrev = [];         // per soldier {x,z} for speed estimation
const gTorso = new THREE.CapsuleGeometry(0.16, 0.30, 3, 8);
const gHead = new THREE.SphereGeometry(0.145, 10, 8);
const gLeg = new THREE.CapsuleGeometry(0.085, 0.34, 3, 6); gLeg.translate(0, -0.255, 0); // pivot at hip
const gArm = new THREE.CapsuleGeometry(0.065, 0.32, 3, 6); gArm.translate(0, -0.225, 0); // pivot at shoulder
// matrix scratch for composing root * part transforms
const _root = new THREE.Matrix4(), _part = new THREE.Matrix4();
const _qY = new THREE.Quaternion(), _qX = new THREE.Quaternion();
const _pos = new THREE.Vector3(), _pos2 = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _YA = new THREE.Vector3(0, 1, 0), _XA = new THREE.Vector3(1, 0, 0);

// spears/pikes in infantry hands
let weaponMesh = null;
const weaponIdx = []; // soldier i -> instance slot or -1
const weaponLower = []; // soldier i -> seconds left holding the weapon leveled
const weaponGeo = new THREE.BoxGeometry(0.07, 0.07, 1);
weaponGeo.translate(0, 0, 0.5); // extend forward from the hand
const weaponMat = new THREE.MeshStandardMaterial({ color: 0x8a6b3d, roughness: 0.9 });

function buildRenderers() {
  for (const m of [hTorso, hHead, hArm, hLeg, weaponMesh]) if (m) { scene.remove(m); m.dispose(); }
  for (const m of catMeshes.values()) scene.remove(m);
  catMeshes.clear();

  soldierUnitIdx.length = 0;
  meta.units.forEach((u, j) => { for (let i = 0; i < u.n; i++) soldierUnitIdx[u.start + i] = j; });

  // pick one leader soldier per team (centre of that team's first melee unit)
  leaderIndex[0] = leaderIndex[1] = -1;
  for (const u of meta.units) {
    if (leaderIndex[u.team] < 0 && u.type !== 'catapult') leaderIndex[u.team] = u.start + Math.floor(u.n / 2);
  }

  const nS = meta.nS;
  const mk = (geo, count) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.75 }), count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; scene.add(m); return m;
  };
  hTorso = mk(gTorso, nS); hHead = mk(gHead, nS); hLeg = mk(gLeg, nS * 2); hArm = mk(gArm, nS * 2);
  for (let i = 0; i < nS; i++) {
    const col = TEAM_COLORS[meta.units[soldierUnitIdx[i]].team];
    hTorso.setColorAt(i, col); hHead.setColorAt(i, col);
    hLeg.setColorAt(i * 2, col); hLeg.setColorAt(i * 2 + 1, col);
    hArm.setColorAt(i * 2, col); hArm.setColorAt(i * 2 + 1, col);
    colorKey[i] = -1; walkPhase[i] = Math.random() * 6.28; soPrev[i] = null;
  }
  for (const m of [hTorso, hHead, hLeg, hArm]) m.instanceColor.needsUpdate = true;

  meta.units.forEach((u, j) => { if (u.type === 'catapult') catMeshes.set(j, makeCatapultMesh(u.team)); });

  // spears/pikes in infantry hands
  let nW = 0;
  for (let i = 0; i < nS; i++) { const t = meta.units[soldierUnitIdx[i]].type; weaponIdx[i] = (t === 'spear' || t === 'pike') ? nW++ : -1; }
  weaponMesh = new THREE.InstancedMesh(weaponGeo, weaponMat, Math.max(1, nW));
  weaponMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); weaponMesh.frustumCulled = false;
  for (let i = 0; i < weaponMesh.count; i++) weaponMesh.setMatrixAt(i, _zeroM);
  scene.add(weaponMesh);
}

function makeCatapultMesh(team) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4f2e, roughness: 0.9 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 3.2), wood);
  base.position.y = 0.5;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 3.4), wood);
  arm.position.set(0, 1.4, -0.3); arm.rotation.x = -0.7;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.4, 0.4), wood);
  bar.position.set(0, 1.1, 0.9);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.05), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team] }));
  flag.position.set(0, 2.4, 1.2);
  g.add(base, arm, bar, flag);
  scene.add(g);
  return g;
}

// arrow volleys (instanced thin boxes) + catapult stones (pooled spheres)
const ARROW_CAP = 600;
const arrowMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.06, 0.06, 0.9),
  new THREE.MeshBasicMaterial({ color: 0xd8cfae }), ARROW_CAP
);
arrowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
arrowMesh.frustumCulled = false;
scene.add(arrowMesh);
const flyingArrows = [];

// ---------------- physics props: fort bricks + ragdoll corpses ----------------
// One instanced mesh each, driven by full 3D transforms (pos+quat) from the sim
// (solo: read the arena buffer directly; net: the decoded snapshot props).
// pools sized to the largest tier so any server tier fits (unused instances hidden)
const BRICK_CAP = 24000, RAGDOLL_BONE_CAP = 128 * 14 + 16;
const brickMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x9a8f7c, roughness: 1 }),
  BRICK_CAP
);
// jointed ragdoll bones: one capsule instance per bone (cap * 14 bones). Base
// capsule has radius 1 and cylinder length 2 (y: -1..1); per instance we scale
// x/z by the bone radius and y by its half-length, and orient by the streamed quat.
const ragdollMesh = new THREE.InstancedMesh(
  new THREE.CapsuleGeometry(1, 2, 4, 8),
  new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.9 }),
  RAGDOLL_BONE_CAP
);
// siege engines (trebuchet frames/arms + battering rams) — wooden boxes
const woodMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x6b4626, roughness: 0.9 }),
  96
);
for (const m of [brickMesh, ragdollMesh, woodMesh]) {
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.castShadow = false;
  scene.add(m);
}
// ---------------- champion leaders (one animated GLB gladiator per team) ----------------
// Small CC0 KayKit rigs (~1.6 MB) with embedded Walking_A / Idle / Death_A clips.
// The rest of each army stays instanced; only the leader is a skinned mesh.
const LEADER_MODEL = ['./assets/mobs/gladiators/knight.glb', './assets/mobs/gladiators/barbarian.glb'];
const leaders = [null, null];         // { root, mixer, actions, current, prevX, prevZ }
const leaderIndex = [-1, -1];         // soldier instance index rendered as the leader
const leaderState = [null, null];     // {x, z, face, state} filled each frame
function setLeaderAnim(L, name) {
  if (L.current === name || !L.actions[name]) return;
  const to = L.actions[name]; to.reset().setEffectiveWeight(1).play();
  const from = L.actions[L.current];
  if (from) from.crossFadeTo(to, 0.25, false);
  L.current = name;
}
(function loadLeaders() {
  if (CONFIG.heroesPerTeam <= 0) return; // leaders disabled
  const loader = new GLTFLoader();
  for (let team = 0; team < 2; team++) {
    loader.loadAsync(LEADER_MODEL[team]).then((gltf) => {
      const root = gltf.scene;
      root.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; } });
      root.scale.setScalar(1.7);
      root.visible = false;
      scene.add(root);
      const mixer = new THREE.AnimationMixer(root);
      const act = (n) => { const c = THREE.AnimationClip.findByName(gltf.animations, n); return c ? mixer.clipAction(c) : null; };
      const actions = { idle: act('Idle'), walk: act('Walking_A'), death: act('Death_A') };
      if (actions.idle) actions.idle.play();
      leaders[team] = { root, mixer, actions, current: 'idle', prevX: 0, prevZ: 0 };
    }).catch((e) => console.warn('leader model failed to load:', LEADER_MODEL[team], e));
  }
})();

// ---------------- capture the flag: banners + score ----------------
let flagsData = null, scoresData = null;
const flagGroups = [0, 1].map((team) => {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 6), new THREE.MeshStandardMaterial({ color: 0x6b5330 }));
  pole.position.y = 1.5;
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.06),
    new THREE.MeshStandardMaterial({ color: team === 0 ? 0xd23c3c : 0x3c64d2, side: THREE.DoubleSide, emissive: team === 0 ? 0x400 : 0x004 }));
  cloth.position.set(0.62, 2.55, 0);
  g.add(pole, cloth); g.visible = false; scene.add(g);
  return g;
});
const scoreEl = document.createElement('div');
scoreEl.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);font-size:22px;font-weight:bold;text-shadow:0 2px 5px #000;display:none';
document.body.appendChild(scoreEl);
function updateFlags() {
  const f = mode === 'solo' ? (sim && sim.flags) : flagsData;
  const sc = mode === 'solo' ? (sim && sim.scores) : scoresData;
  if (!f) { flagGroups[0].visible = flagGroups[1].visible = false; scoreEl.style.display = 'none'; return; }
  for (let t = 0; t < 2; t++) {
    const fl = f[t]; if (!fl) continue;
    flagGroups[t].visible = true;
    flagGroups[t].position.set(fl.x, fl.state === 'carried' ? 0.6 : 0, fl.z); // ride higher when carried
  }
  if (sc) { scoreEl.style.display = 'block'; scoreEl.innerHTML = `<span style="color:#e88">🚩 Red ${sc[0]}</span> &nbsp; <span style="color:#8ae">Blue ${sc[1]} 🚩</span>`; }
}


// ---------------- domination: capture-zone rings + ticket HUD ----------------
let zonesData = null, ticketsData = null;
const ZONE_COLORS = [0xd23c3c, 0x3c64d2]; // holder red/blue; gray when unheld
const zoneRings = [];
const domEl = document.createElement('div');
domEl.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);font:bold 20px system-ui;text-shadow:0 2px 5px #000;display:none;color:#ddd;pointer-events:none';
document.body.appendChild(domEl);
function updateDom() {
  const zs = mode === 'solo' ? (sim && sim.zones) : zonesData;
  const tk = mode === 'solo' ? (sim && sim.tickets) : ticketsData;
  if (!zs) { domEl.style.display = 'none'; for (const r of zoneRings) r.visible = false; return; }
  while (zoneRings.length < zs.length) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(zs[zoneRings.length].r - 1, zs[zoneRings.length].r, 48),
      new THREE.MeshBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1;
    scene.add(ring); zoneRings.push(ring);
  }
  zs.forEach((z, i) => {
    const r = zoneRings[i];
    r.visible = true;
    r.position.set(z.x, 0.1, z.z);
    r.material.color.setHex(z.holder === -1 ? 0x999999 : ZONE_COLORS[z.holder]);
  });
  if (tk) {
    domEl.style.display = 'block';
    domEl.innerHTML = `<span style="color:#e88">⚑ Red ${tk[0]}</span> &nbsp;·&nbsp; <span style="color:#8ae">${tk[1]} Blue ⚑</span>`;
  }
}

let lastBricks = 0, lastRags = 0, lastWood = 0;
function updateProps() {
  let nb = 0, nr = 0, nw = 0;
  const put = (kind, x, y, z, qx, qy, qz, qw, hx, hy, hz) => {
    dummy.position.set(x, y, z);
    dummy.quaternion.set(qx, qy, qz, qw);
    if (kind === 5) { // ragdoll bone: capsule, x/z = radius, y = half-length
      if (nr >= ragdollMesh.count) return;
      dummy.scale.set(hx, hy, hz);
      dummy.updateMatrix(); ragdollMesh.setMatrixAt(nr++, dummy.matrix);
    } else if (kind === 7 || kind === 8) { // siege engine timber (trebuchet frame/arm, ram)
      if (nw >= woodMesh.count) return;
      dummy.scale.set(hx * 2, hy * 2, hz * 2);
      dummy.updateMatrix(); woodMesh.setMatrixAt(nw++, dummy.matrix);
    } else { // brick (2) or rubble (6)
      if (nb >= brickMesh.count) return;
      dummy.scale.set(hx * 2, hy * 2, hz * 2);
      dummy.updateMatrix(); brickMesh.setMatrixAt(nb++, dummy.matrix);
    }
  };
  if (mode === 'solo' && sim) {
    const xf = sim.arena.transforms, ST = sim.arena.XF_STRIDE, cnt = sim.arena.count;
    for (let h = 0; h < cnt; h++) {
      const b = h * ST, k = xf[b + 7];
      if (k === 2 || k === 5 || k === 6 || k === 7 || k === 8) put(k, xf[b], xf[b + 1], xf[b + 2], xf[b + 3], xf[b + 4], xf[b + 5], xf[b + 6], xf[b + 8], xf[b + 9], xf[b + 10]);
    }
  } else if (mode === 'net') {
    const s = snaps[snaps.length - 1];
    if (s && s.props) {
      const P = s.props;
      for (let i = 0; i < s.nProps; i++) { const p = i * 11; put(P[p + 10], P[p], P[p + 1], P[p + 2], P[p + 3], P[p + 4], P[p + 5], P[p + 6], P[p + 7], P[p + 8], P[p + 9]); }
    }
  }
  dummy.scale.setScalar(0); dummy.updateMatrix();
  for (let i = nb; i < lastBricks; i++) brickMesh.setMatrixAt(i, dummy.matrix);
  for (let i = nr; i < lastRags; i++) ragdollMesh.setMatrixAt(i, dummy.matrix);
  for (let i = nw; i < lastWood; i++) woodMesh.setMatrixAt(i, dummy.matrix);
  lastBricks = nb; lastRags = nr; lastWood = nw;
  brickMesh.instanceMatrix.needsUpdate = true;
  ragdollMesh.instanceMatrix.needsUpdate = true;
  woodMesh.instanceMatrix.needsUpdate = true;
}

const stonePool = [];
const stoneGeo = new THREE.SphereGeometry(0.45, 8, 8);
const stoneMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a });
const flyingStones = [];
function getStone() {
  let m = stonePool.pop();
  if (!m) { m = new THREE.Mesh(stoneGeo, stoneMat); scene.add(m); }
  m.visible = true;
  return m;
}

// destination arrows for selected units
const orderArrows = Array.from({ length: 40 }, () => {
  const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffe066, 2.4, 1.4);
  a.visible = false;
  scene.add(a);
  return a;
});

// ---------------- particles ----------------
const POOL = 3000;
const pPos = new Float32Array(POOL * 3).fill(-999);
const pCol = new Float32Array(POOL * 3);
const parts = Array.from({ length: POOL }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
let pNext = 0;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.35, vertexColors: true }));
points.frustumCulled = false;
scene.add(points);
const tmpColor = new THREE.Color();
function spawnParticles(x, y, z, count, color, speed, life) {
  for (let i = 0; i < count; i++) {
    const j = pNext; pNext = (pNext + 1) % POOL;
    const p = parts[j];
    p.life = life * (0.5 + Math.random() * 0.5);
    const a = Math.random() * Math.PI * 2, sp = speed * (0.3 + Math.random() * 0.7);
    p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = Math.random() * sp * 1.4;
    pPos[j * 3] = x; pPos[j * 3 + 1] = y; pPos[j * 3 + 2] = z;
    tmpColor.set(color).multiplyScalar(0.7 + Math.random() * 0.5);
    pCol[j * 3] = tmpColor.r; pCol[j * 3 + 1] = tmpColor.g; pCol[j * 3 + 2] = tmpColor.b;
  }
  pGeo.attributes.color.needsUpdate = true;
}
function updateParticles(dt) {
  for (let j = 0; j < POOL; j++) {
    const p = parts[j];
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { pPos[j * 3 + 1] = -999; continue; }
    p.vy -= 22 * dt;
    let y = pPos[j * 3 + 1] + p.vy * dt;
    if (y < 0.05) { y = 0.05; p.vy = 0; p.vx *= 0.85; p.vz *= 0.85; }
    pPos[j * 3] += p.vx * dt; pPos[j * 3 + 1] = y; pPos[j * 3 + 2] += p.vz * dt;
  }
  pGeo.attributes.position.needsUpdate = true;
}

// ---------------- events / ticker ----------------
const ticker = document.getElementById('ticker');
const tickerLines = [];
function note(text) {
  const cls = text.startsWith('Red') ? 't0' : text.startsWith('Blue') ? 't1' : '';
  tickerLines.push(`<span class="${cls}">${text}</span>`);
  if (tickerLines.length > 6) tickerLines.shift();
  ticker.innerHTML = tickerLines.join('<br>');
}
function handleEvent(ev) {
  const [kind, ...a] = ev;
  if (kind === 'boom') {
    spawnParticles(a[0], 0.5, a[1], 45, 0xff8833, 9, 0.9);
    spawnParticles(a[0], 0.5, a[1], 30, 0x777777, 5, 1.4);
    spawnParticles(a[0], 0.3, a[1], 20, 0xbbaa88, 7, 0.8);
  } else if (kind === 'firebomb') { // fire pot: a much bigger fireball + smoke column
    spawnParticles(a[0], 0.6, a[1], 90, 0xff5511, 16, 1.2);
    spawnParticles(a[0], 1.0, a[1], 60, 0xffcc33, 12, 0.9);
    spawnParticles(a[0], 1.5, a[1], 50, 0x333333, 6, 2.2);
    spawnParticles(a[0], 0.3, a[1], 30, 0xbbaa88, 10, 1.0);
  } else if (kind === 'shot') {
    flyingStones.push({ sx: a[0], sz: a[1], tx: a[2], tz: a[3], dur: a[4], t: 0, mesh: getStone() });
    spawnParticles(a[0], 2, a[1], 8, 0xbbaa88, 3, 0.6);
  } else if (kind === 'arrow') {
    flyingArrows.push({ sx: a[0], sz: a[1], tx: a[2], tz: a[3], dur: a[4], t: 0 });
  } else if (kind === 'note') note(a[0]);
  else if (kind === 'over') winner = a[0];
}

// ---------------- camera ----------------
const camTarget = new THREE.Vector3(0, 0, 35);
let zoom = 95, viewDir = 1;
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyT' && selected.size) sendCmd({ type: 'stance', unitIds: [...selected] });
  if (e.code === 'BracketLeft' && selected.size) sendCmd({ type: 'files', unitIds: [...selected], d: -1 });
  if (e.code === 'BracketRight' && selected.size) sendCmd({ type: 'files', unitIds: [...selected], d: 1 });
});
addEventListener('keyup', (e) => (keys[e.code] = false));
addEventListener('wheel', (e) => { zoom = clamp(zoom + e.deltaY * 0.08, 25, 170); });
function updateCamera(dt) {
  const s = zoom * 0.6 * dt;
  if (keys.KeyW || keys.ArrowUp) camTarget.z -= s * viewDir;
  if (keys.KeyS || keys.ArrowDown) camTarget.z += s * viewDir;
  if (keys.KeyA || keys.ArrowLeft) camTarget.x -= s * viewDir;
  if (keys.KeyD || keys.ArrowRight) camTarget.x += s * viewDir;
  camTarget.x = clamp(camTarget.x, -FIELD_W / 2, FIELD_W / 2);
  camTarget.z = clamp(camTarget.z, -FIELD_D / 2, FIELD_D / 2);
  camera.position.set(camTarget.x, zoom, camTarget.z + zoom * 0.55 * viewDir);
  camera.lookAt(camTarget);
}

// ---------------- selection & orders ----------------
const selected = new Set(); // unit indices
const marquee = document.getElementById('marquee');
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const unitCentroids = []; // filled each frame: {x,z,n}

function ownsUnit(j) {
  const u = meta.units[j];
  if (!you || you.spectator) return false;
  if (u.team !== you.team) return false;
  return you.slot === -1 || u.slot === you.slot;
}
function groundPoint(cx, cy) {
  ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  const t = -o.y / d.y;
  return { x: o.x + d.x * t, z: o.z + d.z * t };
}
function screenPos(x, z) {
  const v = new THREE.Vector3(x, 0, z).project(camera);
  return { x: (v.x + 1) / 2 * innerWidth, y: (-v.y + 1) / 2 * innerHeight };
}

const previewGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const previewLine = new THREE.Line(previewGeo, new THREE.LineBasicMaterial({ color: 0xffe066 }));
previewLine.visible = false;
previewLine.position.y = 0.15;
scene.add(previewLine);

let selStart = null, ordStart = null;
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 0) selStart = { x: e.clientX, y: e.clientY };
  if (e.button === 2) ordStart = groundPoint(e.clientX, e.clientY);
});
addEventListener('pointermove', (e) => {
  if (selStart) {
    marquee.style.display = 'block';
    marquee.style.left = Math.min(selStart.x, e.clientX) + 'px';
    marquee.style.top = Math.min(selStart.y, e.clientY) + 'px';
    marquee.style.width = Math.abs(e.clientX - selStart.x) + 'px';
    marquee.style.height = Math.abs(e.clientY - selStart.y) + 'px';
  }
  if (ordStart && selected.size) {
    const p = groundPoint(e.clientX, e.clientY);
    previewLine.visible = true;
    const pos = previewGeo.attributes.position;
    pos.setXYZ(0, ordStart.x, 0, ordStart.z);
    pos.setXYZ(1, p.x, 0, p.z);
    pos.needsUpdate = true;
  }
});
addEventListener('pointerup', (e) => {
  if (e.button === 0 && selStart) {
    const x0 = Math.min(selStart.x, e.clientX), x1 = Math.max(selStart.x, e.clientX);
    const y0 = Math.min(selStart.y, e.clientY), y1 = Math.max(selStart.y, e.clientY);
    const drag = x1 - x0 > 6 || y1 - y0 > 6;
    const picked = [];
    let clickBest = null, clickD = 45;
    meta.units.forEach((u, j) => {
      const c = unitCentroids[j];
      if (!ownsUnit(j) || !c || !c.n) return;
      const sp = screenPos(c.x, c.z);
      if (drag) {
        if (sp.x >= x0 && sp.x <= x1 && sp.y >= y0 && sp.y <= y1) picked.push(j);
      } else {
        const d = Math.hypot(sp.x - e.clientX, sp.y - e.clientY);
        if (d < clickD) { clickD = d; clickBest = j; }
      }
    });
    selected.clear();
    for (const j of drag ? picked : clickBest !== null ? [clickBest] : []) selected.add(j);
    selStart = null;
    marquee.style.display = 'none';
  }
  if (e.button === 2 && ordStart) {
    if (selected.size) {
      const p1 = groundPoint(e.clientX, e.clientY);
      sendCmd({ type: 'order', unitIds: [...selected], p0: [ordStart.x, ordStart.z], p1: [p1.x, p1.z] });
      spawnParticles(p1.x, 0.3, p1.z, 8, 0xffe066, 2, 0.5);
    }
    ordStart = null;
    previewLine.visible = false;
  }
});

// ---------------- per-frame instance update ----------------
const rs = {}; // reusable readSoldier output
const _zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
function hideHuman(i) {
  hTorso.setMatrixAt(i, _zeroM); hHead.setMatrixAt(i, _zeroM);
  hLeg.setMatrixAt(i * 2, _zeroM); hLeg.setMatrixAt(i * 2 + 1, _zeroM);
  hArm.setMatrixAt(i * 2, _zeroM); hArm.setMatrixAt(i * 2 + 1, _zeroM);
}
// place one body part: world = root * translate(o) * rotX(swing)
function placePart(mesh, idx, ox, oy, oz, swingX) {
  _qX.setFromAxisAngle(_XA, swingX);
  _part.compose(_pos.set(ox, oy, oz), _qX, _one);
  _part.premultiply(_root);
  mesh.setMatrixAt(idx, _part);
}
function updateInstances(dt) {
  if (!hTorso) return;
  for (const c of unitCentroids) if (c) { c.x = 0; c.z = 0; c.n = 0; }
  meta.units.forEach((u, j) => { unitCentroids[j] = unitCentroids[j] || {}; unitCentroids[j].x = 0; unitCentroids[j].z = 0; unitCentroids[j].n = 0; });

  let colorDirty = false;
  for (let i = 0; i < meta.nS; i++) {
    if (!readSoldier(i, rs)) return;
    const j = soldierUnitIdx[i], u = meta.units[j];
    const isCav = u.type === 'cavalry';

    const lt = i === leaderIndex[0] ? 0 : i === leaderIndex[1] ? 1 : -1;
    if (lt >= 0 && leaders[lt]) { // rendered as the animated GLB champion instead
      leaderState[lt] = { x: rs.x, z: rs.z, face: rs.face, state: rs.state };
      hideHuman(i);
      const wl = weaponIdx[i]; if (wl >= 0) weaponMesh.setMatrixAt(wl, _zeroM);
      continue;
    }

    if (rs.state !== 0) { // dead: hide the humanoid; the jointed ragdoll shows the corpse
      hideHuman(i);
      const wl = weaponIdx[i]; if (wl >= 0) weaponMesh.setMatrixAt(wl, _zeroM);
      continue;
    }

    const c = unitCentroids[j];
    c.x += rs.x; c.z += rs.z; c.n++;

    // gait: advance a walk phase by movement speed; swing legs/arms accordingly
    const pv = soPrev[i] || (soPrev[i] = { x: rs.x, z: rs.z });
    const spd = Math.hypot(rs.x - pv.x, rs.z - pv.z) / Math.max(dt, 1e-3);
    pv.x = rs.x; pv.z = rs.z;
    const downed = !!rs.down;
    const amp = downed ? 0 : Math.min(1, spd / 2.5);
    walkPhase[i] += (3 + spd * 1.5) * dt;
    const sw = Math.sin(walkPhase[i]) * 0.7 * amp;
    const bob = Math.abs(Math.sin(walkPhase[i])) * 0.04 * amp;
    const sc = isCav ? 1.18 : 1.0;

    _qY.setFromAxisAngle(_YA, rs.face);
    if (downed) { _qX.setFromAxisAngle(_XA, -1.42); _qY.multiply(_qX); } // knocked flat on their back
    _root.compose(_pos.set(rs.x, 0, rs.z), _qY, _pos2.set(sc, sc, sc)); // downed: rotation lays parts near y≈0.1-0.2
    placePart(hTorso, i, 0, 0.98 + bob, 0, 0);
    placePart(hHead, i, 0, 1.42 + bob, 0, 0);
    placePart(hLeg, i * 2, 0.09, 0.74, 0, downed ? 0.35 : sw);
    placePart(hLeg, i * 2 + 1, -0.09, 0.74, 0, downed ? 0.2 : -sw);
    const rArm = downed ? 0.6 : rs.fighting ? -1.3 : sw * 0.8; // splayed when down, strike when fighting
    placePart(hArm, i * 2, 0.24, 1.2, 0, downed ? 0.5 : -sw * 0.8);
    placePart(hArm, i * 2 + 1, -0.24, 1.2, 0, rArm);
    if (rs.fighting && Math.random() < dt * 1.2) spawnParticles(rs.x, 1.2, rs.z, 2, 0xaa1515, 3, 0.5);

    const wi = weaponIdx[i];
    if (wi >= 0) {
      weaponLower[i] = rs.fighting ? 1.5 : Math.max(0, (weaponLower[i] || 0) - dt);
      dummy.position.set(rs.x + Math.sin(rs.face) * 0.25, 1.15, rs.z + Math.cos(rs.face) * 0.25);
      dummy.rotation.set(rs.stance || weaponLower[i] > 0 ? -0.12 : -0.95, rs.face, 0);
      dummy.scale.set(1, 1, TYPES[u.type].range + 0.8);
      dummy.updateMatrix();
      weaponMesh.setMatrixAt(wi, dummy.matrix);
    }

    // recolor parts only when team/broken/selected state changes
    const key = (rs.broken ? 4 : 0) | (selected.has(j) ? 8 : 0);
    if (colorKey[i] !== key) {
      colorKey[i] = key;
      const base = TEAM_COLORS[u.team];
      const col = rs.broken ? base.clone().lerp(WHITE, 0.6) : selected.has(j) ? base.clone().lerp(WHITE, 0.45) : base;
      hTorso.setColorAt(i, col); hHead.setColorAt(i, col);
      hLeg.setColorAt(i * 2, col); hLeg.setColorAt(i * 2 + 1, col);
      hArm.setColorAt(i * 2, col); hArm.setColorAt(i * 2 + 1, col);
      colorDirty = true;
    }
  }
  for (const m of [hTorso, hHead, hLeg, hArm]) { if (colorDirty) m.instanceColor.needsUpdate = true; m.instanceMatrix.needsUpdate = true; }
  weaponMesh.instanceMatrix.needsUpdate = true;

  // place & animate each team's champion at its leader soldier; walk when moving,
  // idle when still, death when killed (KayKit rigs face -Z, hence face + PI)
  for (let t = 0; t < 2; t++) {
    const L = leaders[t], st = leaderState[t];
    if (!L) continue;
    if (st && st.state !== 2) {
      L.root.visible = true;
      L.root.position.set(st.x, 0, st.z);
      L.root.rotation.y = st.face + Math.PI;
      const sp = Math.hypot(st.x - L.prevX, st.z - L.prevZ);
      L.prevX = st.x; L.prevZ = st.z;
      setLeaderAnim(L, st.state === 1 ? 'death' : sp > 0.02 ? 'walk' : 'idle');
    } else L.root.visible = false;
    L.mixer.update(dt);
    leaderState[t] = null;
  }

  for (const c of unitCentroids) if (c && c.n) { c.x /= c.n; c.z /= c.n; }

  // catapult machines follow their crews
  for (const [j, mesh] of catMeshes) {
    const c = unitCentroids[j], ud = readUnit(j);
    if (!ud || !ud.alive || !c.n) { mesh.visible = false; continue; }
    mesh.visible = true;
    mesh.position.set(c.x, 0, c.z);
    mesh.rotation.y = Math.atan2(ud.ax - c.x, ud.az - c.z) || mesh.rotation.y;
  }

  // destination arrows for selected units
  let ai = 0;
  for (const j of selected) {
    const c = unitCentroids[j], ud = readUnit(j);
    if (!c || !c.n || !ud || ai >= orderArrows.length) continue;
    const dx = ud.ax - c.x, dz = ud.az - c.z, d = Math.hypot(dx, dz);
    if (d < 3) continue;
    const a = orderArrows[ai++];
    a.visible = true;
    a.position.set(c.x, 0.3, c.z);
    a.setDirection(new THREE.Vector3(dx / d, 0, dz / d));
    a.setLength(d, Math.min(3, d * 0.3), 1.6);
  }
  for (; ai < orderArrows.length; ai++) orderArrows[ai].visible = false;
}

function updateProjectiles(dt) {
  for (let i = flyingStones.length - 1; i >= 0; i--) {
    const p = flyingStones[i];
    p.t += dt;
    if (p.t >= p.dur) { p.mesh.visible = false; stonePool.push(p.mesh); flyingStones.splice(i, 1); continue; }
    const t = p.t / p.dur;
    p.mesh.position.set(p.sx + (p.tx - p.sx) * t, 1 + 16 * 4 * t * (1 - t), p.sz + (p.tz - p.sz) * t);
  }
  let n = 0;
  for (let i = flyingArrows.length - 1; i >= 0; i--) {
    const a = flyingArrows[i];
    a.t += dt;
    if (a.t >= a.dur) { flyingArrows.splice(i, 1); continue; }
  }
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3();
  for (const a of flyingArrows) {
    if (n >= ARROW_CAP) break;
    const t = a.t / a.dur, dist = Math.hypot(a.tx - a.sx, a.tz - a.sz);
    const h = 1.5 + dist * 0.12;
    const pos = (tt) => v0.set(a.sx + (a.tx - a.sx) * tt, 1.4 + h * 4 * tt * (1 - tt), a.sz + (a.tz - a.sz) * tt);
    pos(t); v1.copy(v0); pos(Math.min(1, t + 0.03));
    dummy.position.copy(v1);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.lookAt(v0);
    dummy.updateMatrix();
    arrowMesh.setMatrixAt(n++, dummy.matrix);
  }
  dummy.scale.setScalar(0);
  dummy.updateMatrix();
  for (let i = n; i < ARROW_CAP; i++) arrowMesh.setMatrixAt(i, dummy.matrix);
  arrowMesh.instanceMatrix.needsUpdate = true;
}

// ---------------- HUD / mechanics panel ----------------
const hud = document.getElementById('hud');
const mech = document.getElementById('mech');
const banner = document.getElementById('banner');
let hudT = 0, ended = false;
const fmt = (n) => Math.round(n).toLocaleString();

// ---------------- lobby ----------------
const lobbyEl = document.getElementById('lobby');
const rosterEl = document.getElementById('roster');
const fightBtn = document.getElementById('fight');
function showLobby(roster) {
  fightBtn.textContent = 'FIGHT';
  fightBtn.style.display = you && you.spectator ? 'none' : '';
  rosterEl.innerHTML = roster.map((r) => {
    const isYou = mode === 'solo' ? r.team === 0 : you && !you.spectator && r.team === you.team && r.slot === you.slot;
    return `<div class="row t${r.team}">${r.team === 0 ? 'Red' : 'Blue'} ${r.slot + 1} — ${isYou ? '<span class="you">YOU</span>' : r.human ? 'Human' : 'AI'}</div>`;
  }).join('');
  lobbyEl.style.display = 'flex';
}
fightBtn.onclick = () => {
  if (mode === 'net') ws.send(JSON.stringify({ type: 'fight' }));
  else if (winner !== null) startSolo(); // rematch -> fresh solo lobby
  else { phase = 'playing'; lobbyEl.style.display = 'none'; }
};

function updateHud() {
  const modeLabel = mode === 'net'
    ? (you.spectator ? 'ONLINE spectator' : `ONLINE — you are ${you.team === 0 ? 'Red' : 'Blue'} player ${you.slot + 1}`)
    : 'SOLO vs AI (no server found)';
  let selLine = '';
  if (selected.size) {
    const parts = [...selected].map((j) => {
      const u = meta.units[j], ud = readUnit(j);
      return `${u.type}${ud && ud.stance ? ` [${TYPES[u.type].alt.name}]` : ''}${ud ? ` m${Math.round(ud.morale)}` : ''}`;
    });
    selLine = `<br>Selected: ${parts.join(' · ')}`;
  }
  hud.innerHTML = `<b style="color:#e66">Red ${countsData[0]}</b> vs <b style="color:#68f">Blue ${countsData[1]}</b> — ${modeLabel}${selLine}` +
    `<br>LMB drag: select · RMB drag: form line · RMB click: move · T: testudo/phalanx · [ ]: width · WASD pan · wheel zoom`;

  if (statsData) {
    const s = statsData;
    const pct = s.arrows.fired ? Math.round(s.arrows.hits / s.arrows.fired * 100) : 0;
    mech.innerHTML = `<h3>MECHANICS PROOF</h3>` +
      `Spears/pikes vs cavalry: <b>${s.spearVsCav.n}</b> hits, +<b>${fmt(s.spearVsCav.dmg)}</b> bonus dmg<br>` +
      `Cavalry charge impacts: <b>${s.charge.n}</b>, +<b>${fmt(s.charge.dmg)}</b> dmg<br>` +
      `Phalanx push bonus: <b>${s.phalanxDmg.n}</b> hits, +<b>${fmt(s.phalanxDmg.dmg)}</b> dmg<br>` +
      `Shield wall blocked melee: <b>${fmt(s.blockMelee.dmg)}</b> dmg (${s.blockMelee.n})<br>` +
      `Shield wall blocked missiles: <b>${fmt(s.blockRanged.dmg)}</b> dmg (${s.blockRanged.n})<br>` +
      `Arrows: <b>${s.arrows.fired}</b> loosed · <b>${s.arrows.hits}</b> hit (${pct}%)<br>` +
      `Boulders: <b>${s.boulders.fired}</b> thrown · <b>${s.boulders.kills}</b> kills<br>` +
      `Routs: <b>${s.routs}</b> · Rallies: <b>${s.rallies}</b>`;
  }
  if (winner !== null && !ended) {
    ended = true;
    banner.style.display = 'flex';
    const won = you && !you.spectator ? winner === you.team : null;
    banner.textContent = won === null ? `${winner === 0 ? 'RED' : 'BLUE'} WINS` : won ? 'VICTORY' : 'DEFEAT';
    setTimeout(() => { if (ended) { fightBtn.textContent = 'REMATCH'; lobbyEl.style.display = 'flex'; } }, 3000);
  }
}

// ---------------- main loop ----------------
connect();
let last = performance.now(), acc = 0;
const STEP = 1 / 60;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (mode === 'solo' && sim && phase === 'playing') {
    acc += dt;
    while (acc >= STEP) { sim.step(STEP); acc -= STEP; }
    for (const ev of sim.drainEvents()) handleEvent(ev);
    statsData = sim.stats; countsData = sim.counts || countsData;
    if (sim.winner !== null) winner = sim.winner;
  }

  updateCamera(dt);
  if (mode) {
    updateInstances(dt);
    updateProps();
    updateFlags();
    updateDom();
    updateProjectiles(dt);
    updateParticles(dt);
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.25; updateHud(); }
  } else {
    hud.textContent = 'connecting…';
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
