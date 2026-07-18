// Bun game server: serves the static files AND runs the authoritative sim.
// Flow: clients join a lobby and claim slots (AI fills the rest), any player
// presses FIGHT to start; after a winner, FIGHT again resets to a new lobby.
// Clients send JSON orders; server broadcasts binary snapshots @ 12Hz plus
// JSON events/stats.
import { createSim } from './sim.js';
import { createArena } from './physics/arena_api.js';
import { CONFIG, setTier } from './physics/config.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? +process.argv[i + 1] : def;
};
const argStr = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const PORT = arg('port', 8321);
const TIER = setTier(argStr('tier', CONFIG.tier)); // low|mid|high|ultra scales the whole scene
// tier sets the default army sizes; --t0/--t1 still override
const PLAYERS = [Math.min(4, Math.max(1, arg('t0', CONFIG.players[0]))), Math.min(4, Math.max(1, arg('t1', CONFIG.players[1])))];
const FORT = arg('fort', 0) > 0; // --fort 1 spawns per-team destructible castles

const clients = new Map(); // ws -> {team, slot} | {spectator:true}
let sim, state; // state: 'lobby' | 'playing'
const arena = await createArena({ maxBodies: CONFIG.maxBodies }); // one box3d world, reused per battle

function resetSim(seed = (Math.random() * 1e9) | 0) {
  sim = createSim({ seed, players: PLAYERS, arena, fort: FORT });
  state = 'lobby';
  for (const who of clients.values()) if (!who.spectator) sim.ai.delete(`${who.team}:${who.slot}`);
}
resetSim(arg('seed', 42) | 0);

function claimSlot() {
  for (let slot = 0; slot < 4; slot++) {
    for (let team = 0; team < 2; team++) {
      if (slot >= PLAYERS[team]) continue;
      if (sim.ai.has(`${team}:${slot}`)) {
        sim.ai.delete(`${team}:${slot}`);
        return { team, slot };
      }
    }
  }
  return { spectator: true };
}

function initMsg(who) {
  return JSON.stringify({
    type: 'init', players: PLAYERS, you: who, state,
    tier: CONFIG.tier, render: CONFIG.render, // so the client matches the server's quality tier
    units: sim.units.map((u) => ({
      id: u.id, team: u.team, slot: u.slot, type: u.typeKey,
      ax: u.ax, az: u.az, facing: u.facing, files: u.files, n: u.type.n,
    })),
  });
}
function lobbyMsg() {
  const roster = [];
  for (let team = 0; team < 2; team++)
    for (let slot = 0; slot < PLAYERS[team]; slot++)
      roster.push({ team, slot, human: !sim.ai.has(`${team}:${slot}`) });
  return JSON.stringify({ type: 'lobby', state, roster });
}
function broadcast(msg) { for (const ws of clients.keys()) ws.send(msg); }

// snapshot: [u8 0x01][u32 tick][per soldier: i16 x*100, i16 z*100, u8 face, u8 flags]
// [per unit: i16 ax*100, i16 az*100, u8 morale, u8 files, u8 flags]
// [u16 nProps][per prop: i16 x,y,z *100, i16 qx,qy,qz,qw *32767, u8 hx,hy,hz *50, u8 kind]
// props = fort bricks (KIND 2) + ragdoll corpses (KIND 5) read from the physics buffer.
const PROP_BYTES = 18;
let tick = 0;
function snapshot() {
  const nS = sim.soldiers.length, nU = sim.units.length;
  const xf = sim.arena.transforms, ST = sim.arena.XF_STRIDE, count = sim.arena.count;
  const props = [];
  for (let h = 0; h < count; h++) { const k = xf[h * ST + 7]; if (k === 2 || k === 5 || k === 6) props.push(h); }
  const nP = props.length;

  const buf = new ArrayBuffer(5 + nS * 6 + nU * 7 + 2 + nP * PROP_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint32(1, tick, true);
  let o = 5;
  for (const s of sim.soldiers) {
    v.setInt16(o, Math.round(s.x * 100), true);
    v.setInt16(o + 2, Math.round(s.z * 100), true);
    v.setUint8(o + 4, Math.round(((s.face % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * 255));
    v.setUint8(o + 5, s.state | (s.fightT > 0 ? 4 : 0) | (s.unit.broken ? 8 : 0) | (s.unit.stance ? 16 : 0));
    o += 6;
  }
  for (const u of sim.units) {
    v.setInt16(o, Math.round(u.ax * 100), true);
    v.setInt16(o + 2, Math.round(u.az * 100), true);
    v.setUint8(o + 4, Math.round(u.morale));
    v.setUint8(o + 5, u.files);
    v.setUint8(o + 6, (u.broken ? 1 : 0) | (u.stance ? 2 : 0) | (u.alive > 0 ? 4 : 0));
    o += 7;
  }
  v.setUint16(o, nP, true); o += 2;
  for (const h of props) {
    const b = h * ST;
    v.setInt16(o, Math.round(xf[b] * 100), true);
    v.setInt16(o + 2, Math.round(xf[b + 1] * 100), true);
    v.setInt16(o + 4, Math.round(xf[b + 2] * 100), true);
    v.setInt16(o + 6, Math.round(xf[b + 3] * 32767), true);
    v.setInt16(o + 8, Math.round(xf[b + 4] * 32767), true);
    v.setInt16(o + 10, Math.round(xf[b + 5] * 32767), true);
    v.setInt16(o + 12, Math.round(xf[b + 6] * 32767), true);
    v.setUint8(o + 14, Math.min(255, Math.round(xf[b + 8] * 50)));
    v.setUint8(o + 15, Math.min(255, Math.round(xf[b + 9] * 50)));
    v.setUint8(o + 16, Math.min(255, Math.round(xf[b + 10] * 50)));
    v.setUint8(o + 17, xf[b + 7]);
    o += PROP_BYTES;
  }
  return buf;
}

Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    if (srv.upgrade(req)) return;
    const url = new URL(req.url);
    const path = url.pathname === '/' ? '/battle.html' : url.pathname;
    const file = Bun.file(import.meta.dir + path);
    // no-store so the browser never serves a stale battle.js / arena.wasm after a rebuild
    return (await file.exists())
      ? new Response(file, { headers: { 'Cache-Control': 'no-store' } })
      : new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      const who = claimSlot();
      clients.set(ws, who);
      ws.send(initMsg(who));
      broadcast(lobbyMsg());
      console.log('join', who);
    },
    close(ws) {
      const who = clients.get(ws);
      clients.delete(ws);
      if (who && !who.spectator) sim.ai.add(`${who.team}:${who.slot}`); // AI takes over
      broadcast(lobbyMsg());
      console.log('leave', who);
    },
    message(ws, raw) {
      const who = clients.get(ws);
      if (!who || who.spectator) return;
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'fight') {
        if (sim.winner !== null) { // rematch -> fresh lobby
          resetSim();
          for (const [w, wh] of clients) w.send(initMsg(wh));
          broadcast(lobbyMsg());
        } else if (state === 'lobby') {
          state = 'playing';
          broadcast(JSON.stringify({ type: 'start' }));
          console.log('FIGHT');
        }
        return;
      }
      if (state !== 'playing' || sim.winner !== null) return;
      const owned = (m.unitIds || []).filter((i) => {
        const u = sim.units[i];
        return u && u.team === who.team && u.slot === who.slot;
      });
      if (!owned.length) return;
      if (m.type === 'order' && m.p0 && m.p1) sim.order(owned, { x: +m.p0[0], z: +m.p0[1] }, { x: +m.p1[0], z: +m.p1[1] });
      else if (m.type === 'stance') sim.toggleStance(owned);
      else if (m.type === 'files') sim.adjustFiles(owned, m.d > 0 ? 1 : -1);
    },
  },
});

// sim @ 30Hz (only while playing), broadcast @ 12Hz (always, so the lobby shows the armies)
const SIM_DT = 1 / 30;
setInterval(() => { if (state === 'playing' && sim.winner === null) sim.step(SIM_DT); }, 1000 * SIM_DT);
setInterval(() => {
  tick++;
  const snap = snapshot();
  const ev = sim.drainEvents();
  const evMsg = JSON.stringify({ type: 'ev', e: ev, stats: sim.stats, counts: sim.counts, winner: sim.winner });
  for (const ws of clients.keys()) { ws.send(snap); ws.send(evMsg); }
}, 1000 / 12);

console.log(`rome-arena server on http://localhost:${PORT}  (tier=${TIER}, ${PLAYERS[0]}v${PLAYERS[1]}${FORT ? ', forts' : ''}, lobby open — press FIGHT in a client to start)`);
