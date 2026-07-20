// An LLM "general" commands one army. Each turn we serialize the battlefield,
// ask the model for orders, and apply them through the sim's existing order API
// (sim.order / toggleStance). Units then execute those orders until the next turn
// — so this is turn-based command at a low polling frequency, not per-frame control.
import { chat } from './providers.js';

const FIELD_X = 100, FIELD_Z = 70; // half-extents (FIELD_W/2, FIELD_D/2)
const teamName = (t) => (t === 0 ? 'RED' : 'BLUE');
const r1 = (n) => Math.round(n);

// Compact battlefield description for the prompt.
function serializeState(sim, team) {
  const desc = (u) => `#${u.id} ${u.typeKey} men=${u.alive}/${u.type.n} morale=${r1(u.morale)}` +
    `${u.broken ? ' BROKEN' : ''}${u.stance ? ' inStance' : ''} at (${r1(u.cx)},${r1(u.cz)})`;
  const mine = sim.units.filter((u) => u.team === team && u.alive > 0);
  const foe = sim.units.filter((u) => u.team !== team && u.alive > 0);
  let situation = '';
  const s = sim.siege;
  if (s && s.mode === 'invasion') {
    const attacking = s.attacker === team;
    const gate = `x=0`, wall = `z=${s.wallZ}`;
    const holes = (sim.breaches || []).map((b) => `(${Math.round(b.x)},${Math.round(b.z)})`);
    situation = `\n\nSIEGE — INVASION. You are the ${attacking ? 'ATTACKER' : 'DEFENDER'}. ` +
      `The defended city fills the z${s.cityDir > 0 ? '>' : '<'}${s.wallZ} side behind a solid wall at ${wall}; the keep is deep inside near (${sim.fortCenter[s.defender]}).` +
      (attacking
        ? ` Your siege towers RAM the wall to tear breaches, then your troops STORM through them. ` +
          `Do NOT pile everyone on the intact wall — mass your infantry at a breach, keep archers back shooting the ramparts, hold cavalry wide to exploit the gap. ` +
          (holes.length ? `Breaches are OPEN at: ${holes.join(', ')} — send melee THROUGH them.` : `No breach yet — stage just outside the wall and wait for the rams (a few seconds).`)
        : ` HOLD the city. Do NOT march out past the wall. Spread your units in depth across the interior; when a breach opens, converge melee on the hole, archers just behind, cavalry as a counter-charge reserve. ` +
          (holes.length ? `Wall is BREACHED at: ${holes.join(', ')} — plug them NOW.` : `Wall still intact — form up in blocks and wait.`));
  } else if (s && s.mode === 'siege') {
    situation = `\n\nSIEGE. Both sides hold a walled city; both attack. Enemy keep near (${sim.fortCenter[1 - team]}), yours near (${sim.fortCenter[team]}). ` +
      `Trebuchets/siege towers breach walls — mass infantry at the breach, archers support, cavalry flanks. Leave a guard on your own city.`;
  } else if (sim.fortCenter && sim.fortCenter[team]) {
    situation = `\nForts: yours ~(${sim.fortCenter[team]}), enemy ~(${sim.fortCenter[1 - team]})`;
  }
  return `Battlefield ${2 * FIELD_X}x${2 * FIELD_Z}, x in [-${FIELD_X},${FIELD_X}], z in [-${FIELD_Z},${FIELD_Z}].` +
    situation +
    `\n\nYOUR UNITS (${teamName(team)}):\n${mine.map(desc).join('\n')}` +
    `\n\nENEMY UNITS:\n${foe.map(desc).join('\n')}`;
}

const SYSTEM = (team) =>
  `You are the general of the ${teamName(team)} army in a real-time ancient battle. ` +
  `Each turn you issue movement orders; units carry them out until your next order. ` +
  `Unit types: legion/spear/pike (melee, pike beats cavalry), archer (ranged), cavalry (fast flankers), catapult (siege). ` +
  `legion and pike can enter a defensive stance (testudo/phalanx). ` +
  `Reply with ONLY a single JSON object and nothing else — no reasoning, no markdown, no <think>:\n` +
  `{"orders":[{"unit":<id>,"x":<num>,"z":<num>,"stance":<0 or 1>}],"taunt":"<short line>"}\n` +
  `Issue AT MOST 5 orders per turn — command the key movements, not every unit. ` +
  `You may also include "strike":{"x":<num>,"z":<num>} to call ONE devastating fire barrage on that point (long cooldown — spend it on massed enemies). ` +
  `Order a unit to march to (x,z) to attack, flank, defend, or besiege. Omit stance unless changing it. Be decisive and tactical.`;

// Pull the orders object out of the reply. Tolerates reasoning models (gpt-oss,
// deepseek) that emit <think>…</think> + prose + code fences: strip those, then
// scan for balanced {…} blocks and return the first that parses with an orders array.
export function parseOrders(text) {
  const clean = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < clean.length; j++) {
      const c = clean[j];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const o = JSON.parse(clean.slice(i, j + 1));
          if (Array.isArray(o.orders)) return { orders: o.orders, taunt: String(o.taunt || ''), strike: o.strike };
        } catch { /* not this block */ }
        break; // move past this '{' to the next candidate
      }
    }
  }
  return { orders: [], taunt: '' };
}

// Offline heuristic used by the `mock` provider: send every unit at the enemy centre.
function mockPlan(sim, team) {
  const foe = sim.units.filter((u) => u.team !== team && u.alive > 0);
  const ex = foe.reduce((s, u) => s + u.cx, 0) / (foe.length || 1);
  const ez = foe.reduce((s, u) => s + u.cz, 0) / (foe.length || 1);
  const orders = sim.units.filter((u) => u.team === team && u.alive > 0)
    .map((u) => ({ unit: u.id, x: r1(ex + (u.cx - ex) * 0.2), z: r1(ez) }));
  return { orders, taunt: '(mock) For glory — advance!' };
}

const MAX_ORDERS = 5; // cap moves applied per turn — a general commands the big picture

// Apply validated orders (up to MAX_ORDERS); returns the count actually issued.
function apply(sim, team, orders) {
  let n = 0;
  for (const o of orders || []) {
    if (n >= MAX_ORDERS) break;
    const u = sim.units[o.unit];
    if (!u || u.team !== team || u.alive <= 0 || u.broken) continue;
    if (Number.isFinite(o.x) && Number.isFinite(o.z)) {
      const p = { x: Math.max(-FIELD_X, Math.min(FIELD_X, o.x)), z: Math.max(-FIELD_Z, Math.min(FIELD_Z, o.z)) };
      sim.order([o.unit], p, p); // point order = form up facing the enemy
      n++;
    }
    if (o.stance != null && u.type.alt && !!u.stance !== !!o.stance) sim.toggleStance([o.unit]);
  }
  return n;
}

// Run one turn for `team`. Returns { taunt, count } (count = orders applied).
export async function commandTeam(sim, team, cfg) {
  let plan;
  if (cfg.mock) {
    plan = mockPlan(sim, team);
  } else {
    const messages = [
      { role: 'system', content: SYSTEM(team) },
      { role: 'user', content: serializeState(sim, team) },
    ];
    plan = parseOrders(await chat(cfg, messages, { maxTokens: 700 })); // keep tokens/turn low (rate limits)
  }
  const count = apply(sim, team, plan.orders);
  // optional called-in fire barrage (cooldown-gated inside the sim)
  if (plan.strike && Number.isFinite(plan.strike.x) && Number.isFinite(plan.strike.z) && sim.strike)
    sim.strike(team, plan.strike.x, plan.strike.z);
  return { taunt: plan.taunt, count };
}
