// Bun game server: serves the static files AND runs the authoritative sim.
// Flow: clients join a lobby and claim slots (AI fills the rest), any player
// presses FIGHT to start; after a winner, FIGHT again resets to a new lobby.
// Clients send JSON orders; server broadcasts binary snapshots @ 12Hz plus
// JSON events/stats.
import { createSim } from './sim.js';
import { createArena } from './physics/arena_api.js';
import { CONFIG, setTier } from './physics/config.js';
import { resolveProvider } from './ai/providers.js';
import { commandTeam } from './ai/commander.js';
import { readdirSync } from 'node:fs';

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
const PLAYERS = [Math.min(16, Math.max(1, arg('t0', CONFIG.players[0]))), Math.min(16, Math.max(1, arg('t1', CONFIG.players[1])))];
const FORT = arg('fort', 0) > 0; // --fort 1 spawns per-team destructible castles (mutual siege)
const INVASION = arg('invasion', 0) > 0; // --invasion 1 = one defended city, the other rams in
const CTF = arg('ctf', 0) > 0;  // --ctf 1 = capture-the-flag mode (small squads + flags)
const DOM = arg('dom', 0) > 0;  // --dom 1 = domination (3 capture zones, ticket bleed)
const AI_TURN = arg('aiturn', 10); // seconds between LLM-general orders (mind Groq TPM limits)
const AUTOSTART = arg('autostart', 0) > 0; // begin the battle with no human FIGHT press
const SEATS = Math.max(1, arg('seats', 2)); // slots a single client commands (default 2)

// LLM generals per team: --ai0 groq --ai1 mock  (providers: groq|openai|pioneer|mock|none)
const commanders = [null, null];
for (let t = 0; t < 2; t++) {
  try { commanders[t] = resolveProvider(argStr(`ai${t}`, 'none')); }
  catch (e) { console.error(`team ${t} AI disabled: ${e.message}`); }
  if (commanders[t]) console.log(`team ${t} commanded by LLM: ${commanders[t].name} (${commanders[t].model})`);
}

const clients = new Map(); // ws -> {team, slot} | {spectator:true}
let sim, state; // state: 'lobby' | 'playing'
const arena = await createArena({ maxBodies: CONFIG.maxBodies }); // one box3d world, reused per battle

function resetSim(seed = (Math.random() * 1e9) | 0) {
  sim = createSim({ seed, players: PLAYERS, arena, fort: FORT, invasion: INVASION, dom: DOM, ctf: CTF });
  state = 'lobby';
  for (const who of clients.values()) if (!who.spectator) for (const s of who.slots) sim.ai.delete(`${who.team}:${s}`);
  // an LLM-commanded team is driven only by its general, not the built-in unit AI
  for (let t = 0; t < 2; t++) if (commanders[t]) for (let s = 0; s < PLAYERS[t]; s++) sim.ai.delete(`${t}:${s}`);
}
resetSim(arg('seed', 42) | 0);

// ---- battle recording for replay ----
// Every playing battle is recorded (init meta + per-tick snapshots + general
// decisions) and written to replays/*.json on the winner, for the replay viewer.
let rec = null, recSaved = false;
const pendingDec = []; // general decisions since the last recorded frame
function startRec() {
  rec = {
    players: PLAYERS, tier: CONFIG.tier, render: CONFIG.render,
    ai: commanders.map((c) => (c ? c.model : null)),
    units: sim.units.map((u) => ({ id: u.id, team: u.team, slot: u.slot, type: u.typeKey, ax: u.ax, az: u.az, facing: u.facing, files: u.files, n: u.n0 })),
    frames: [],
  };
  recSaved = false;
  pendingDec.length = 0;
}
async function saveRec() {
  if (!rec || recSaved || !rec.frames.length) return;
  recSaved = true;
  const name = `replay-${Date.now()}.json`;
  await Bun.write(import.meta.dir + '/replays/' + name, JSON.stringify(rec));
  console.log(`replay saved: replays/${name}  (${rec.frames.length} frames)`);
}

// AI-vs-AI (or --autostart) begins immediately so spectators can just watch.
const autoStart = AUTOSTART || (commanders[0] && commanders[1]);
if (autoStart) { state = 'playing'; startRec(); }

// A client commands up to SEATS slots (default 2), all on one team.
function claimSlot() {
  for (let team = 0; team < 2; team++) {
    const free = [];
    for (let slot = 0; slot < PLAYERS[team]; slot++) if (sim.ai.has(`${team}:${slot}`)) free.push(slot);
    if (free.length) {
      const slots = free.slice(0, SEATS);
      for (const s of slots) sim.ai.delete(`${team}:${s}`);
      return { team, slots };
    }
  }
  return { spectator: true };
}

function initMsg(who) {
  return JSON.stringify({
    type: 'init', players: PLAYERS, you: who, state,
    ai: commanders.map((c) => (c ? c.model : null)), // LLM model per team (null = human/built-in AI)
    tier: CONFIG.tier, render: CONFIG.render,        // so the client matches the server's quality tier
    ctf: CTF, invasion: INVASION,
    units: sim.units.map((u) => ({
      id: u.id, team: u.team, slot: u.slot, type: u.typeKey,
      ax: u.ax, az: u.az, facing: u.facing, files: u.files, n: u.n0,
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
  for (let h = 0; h < count; h++) { const k = xf[h * ST + 7]; if (k === 2 || k === 5 || k === 6 || k === 7 || k === 8) props.push(h); }
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
    v.setUint8(o + 5, s.state | (s.fightT > 0 ? 4 : 0) | (s.unit.broken ? 8 : 0) | (s.unit.stance ? 16 : 0) | (s.down > 0 ? 32 : 0));
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
    if (url.pathname === '/replays') { // JSON list of saved replays, newest first
      let list = [];
      try { list = readdirSync(import.meta.dir + '/replays').filter((f) => f.endsWith('.json')).sort().reverse(); } catch {}
      return new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
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
      if (who && !who.spectator) for (const s of who.slots) sim.ai.add(`${who.team}:${s}`); // AI takes over
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
          startRec();
          broadcast(JSON.stringify({ type: 'start' }));
          console.log('FIGHT');
        }
        return;
      }
      if (state !== 'playing' || sim.winner !== null) return;
      // wrath-of-the-gods strike: aimed at a ground point, gated by the team cooldown
      if (m.type === 'strike' && Array.isArray(m.p) && sim.strike) { sim.strike(who.team, +m.p[0], +m.p[1]); return; }
      const owned = (m.unitIds || []).filter((i) => {
        const u = sim.units[i];
        return u && u.team === who.team && who.slots.includes(u.slot);
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
  // flags carry a live soldier ref (cyclic) — send only the plain render fields
  const flags = sim.flags ? sim.flags.map((f) => ({ team: f.team, x: f.x, z: f.z, state: f.state })) : undefined;
  const strikeCd = sim.strikeReadyIn ? [Math.round(sim.strikeReadyIn(0)), Math.round(sim.strikeReadyIn(1))] : null;
  const evMsg = JSON.stringify({ type: 'ev', e: ev, stats: sim.stats, counts: sim.counts, winner: sim.winner, flags, scores: sim.scores, zones: sim.zones, tickets: sim.tickets, strikeCd });
  for (const ws of clients.keys()) { ws.send(snap); ws.send(evMsg); }
  // record this frame (base64 snapshot + any decisions since last frame) for replay
  if (rec && state === 'playing') {
    rec.frames.push({ snap: Buffer.from(new Uint8Array(snap)).toString('base64'), counts: sim.counts, winner: sim.winner, dec: pendingDec.splice(0) });
    if (sim.winner !== null) saveRec();
  }
}, 1000 / 12);

// LLM generals: each commanded team gets fresh orders every AI_TURN seconds while
// the battle runs. Turns are async (network) and guarded so they never overlap;
// the general's decision is broadcast to the client.
const aiBusy = [false, false];
if (commanders[0] || commanders[1]) {
  setInterval(() => {
    if (state !== 'playing' || sim.winner !== null) return;
    for (let t = 0; t < 2; t++) {
      if (!commanders[t] || aiBusy[t]) continue;
      aiBusy[t] = true;
      commandTeam(sim, t, commanders[t])
        .then(({ taunt, count }) => {
          const dec = { team: t, model: commanders[t].model, taunt: taunt || '…', count };
          pendingDec.push(dec); // recorded into the next frame for replay
          broadcast(JSON.stringify({ type: 'general', ...dec }));
          console.log(`AI ${t === 0 ? 'Red' : 'Blue'} general (${commanders[t].model}): ${taunt || '…'} [${count} orders]`);
        })
        .catch((e) => console.error(`AI team ${t} turn failed: ${e.message}`))
        .finally(() => { aiBusy[t] = false; });
    }
  }, 1000 * AI_TURN);
}

const modeLabel = INVASION ? ', invasion' : FORT ? ', forts' : '';
console.log(`rome-arena server on http://localhost:${PORT}  (tier=${TIER}, ${PLAYERS[0]}v${PLAYERS[1]}${modeLabel}, lobby open — press FIGHT in a client to start)`);
