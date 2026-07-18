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
  const forts = sim.fortCenter ? `\nForts: yours ~(${sim.fortCenter[team]}), enemy ~(${sim.fortCenter[1 - team]})` : '';
  return `Battlefield ${2 * FIELD_X}x${2 * FIELD_Z}, x in [-${FIELD_X},${FIELD_X}], z in [-${FIELD_Z},${FIELD_Z}].` +
    forts +
    `\n\nYOUR UNITS (${teamName(team)}):\n${mine.map(desc).join('\n')}` +
    `\n\nENEMY UNITS:\n${foe.map(desc).join('\n')}`;
}

const SYSTEM = (team) =>
  `You are the general of the ${teamName(team)} army in a real-time ancient battle. ` +
  `Each turn you issue movement orders; units carry them out until your next order. ` +
  `Unit types: legion/spear/pike (melee, pike beats cavalry), archer (ranged), cavalry (fast flankers), catapult (siege). ` +
  `legion and pike can enter a defensive stance (testudo/phalanx). ` +
  `Reply with ONLY a JSON object, no prose:\n` +
  `{"orders":[{"unit":<id>,"x":<num>,"z":<num>,"stance":<0 or 1>}],"taunt":"<short line>"}\n` +
  `Order a unit to march to (x,z) to attack, flank, defend, or besiege. Omit stance unless changing it. Be decisive and tactical.`;

// Pull the first JSON object out of the model's reply (tolerates code fences/prose).
export function parseOrders(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { orders: [], taunt: '' };
  try {
    const o = JSON.parse(m[0]);
    return { orders: Array.isArray(o.orders) ? o.orders : [], taunt: String(o.taunt || '') };
  } catch { return { orders: [], taunt: '' }; }
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

// Apply validated orders; returns the count actually issued.
function apply(sim, team, orders) {
  let n = 0;
  for (const o of orders || []) {
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
    plan = parseOrders(await chat(cfg, messages));
  }
  const count = apply(sim, team, plan.orders);
  return { taunt: plan.taunt, count };
}
