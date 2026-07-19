// Typed JS wrapper over the box3d WASM batch API. Hides cwrap + the shared-HEAP
// buffers so callers work with plain handles and Float32Array views:
//
//   const arena = await createArena({ maxBodies });
//   arena.createGround(FIELD_W, FIELD_D);
//   const h = arena.addSoldier(x, z);
//   arena.intents[h*2] = vx; arena.intents[h*2+1] = vz;   // desired velocity
//   arena.step(dt);
//   const xf = arena.transforms;                          // [x,y,z, qx,qy,qz,qw, kind] * count
//
// Views are re-derived if emscripten grows (and thus detaches) the heap.
import { loadArena } from './arena_loader.js';

export const XF_STRIDE = 11; // x,y,z, qx,qy,qz,qw, kind, hx,hy,hz

export async function createArena({ maxBodies = 20000, seed = 1 } = {}) {
  const { Module } = await loadArena();
  const c = (name, ret, args) => Module.cwrap(name, ret, args);
  const fn = {
    reset: c('arena_reset', null, ['number', 'number']),
    createGround: c('arena_create_ground', null, ['number', 'number']),
    addSoldier: c('arena_add_soldier', 'number', ['number', 'number', 'number']),
    addBrick: c('arena_add_brick', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
    addBoulder: c('arena_add_boulder', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
    remove: c('arena_remove', null, ['number']),
    bodyCount: c('arena_body_count', 'number', []),
    transformPtr: c('arena_transform_ptr', 'number', []),
    intentPtr: c('arena_intent_ptr', 'number', []),
    step: c('arena_step', null, ['number', 'number']),
    contactCount: c('arena_contact_count', 'number', []),
    contactsPtr: c('arena_contacts_ptr', 'number', []),
    raycast: c('arena_raycast', 'number', ['number', 'number', 'number', 'number', 'number', 'number']),
    explode: c('arena_explode', null, ['number', 'number', 'number', 'number', 'number']),
    impulse: c('arena_impulse', null, ['number', 'number', 'number', 'number']),
    addTrebuchet: c('arena_add_trebuchet', 'number', ['number', 'number', 'number']),
    trebuchetFire: c('arena_trebuchet_fire', null, ['number', 'number', 'number', 'number', 'number']),
    trebuchetPoll: c('arena_trebuchet_poll', 'number', ['number']),
    addRam: c('arena_add_ram', 'number', ['number', 'number']),
    setVelocity: c('arena_set_velocity', null, ['number', 'number', 'number']),
    spawnRagdoll: c('arena_spawn_ragdoll', null, ['number', 'number', 'number', 'number', 'number', 'number']),
    setRagdollParams: c('arena_set_ragdoll_params', null, ['number', 'number']),
    renderCount: c('arena_render_count', 'number', []),
    buildFort: c('arena_build_fort', 'number', ['number', 'number', 'number', 'number', 'number']),
    buildWall: c('arena_build_wall', 'number', ['number', 'number', 'number', 'number', 'number', 'number']),
    buildRondel: c('arena_build_rondel', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
    sync: c('arena_sync', null, []),
  };

  let lastBuffer = null, xfView = null, intentView = null, contactView = null;
  const sync = () => {
    if (Module.HEAPF32.buffer === lastBuffer) return;
    lastBuffer = Module.HEAPF32.buffer;
    const xp = fn.transformPtr() >> 2, ip = fn.intentPtr() >> 2; // byte -> f32 index
    xfView = Module.HEAPF32.subarray(xp, xp + maxBodies * XF_STRIDE);
    intentView = Module.HEAPF32.subarray(ip, ip + maxBodies * 2);
    const cp = fn.contactsPtr() >> 2; // byte -> i32 index
    contactView = Module.HEAP32.subarray(cp, cp + 8192 * 2);
  };

  fn.reset(seed, maxBodies);
  sync();

  return {
    Module,
    XF_STRIDE,
    reset(s = seed) { fn.reset(s, maxBodies); lastBuffer = null; sync(); },
    createGround: (w, d) => fn.createGround(w, d),
    addSoldier: (x, z, y = 0) => fn.addSoldier(x, y, z), // optional y: spawn on a wall crest
    addBrick: (x, y, z, hx, hy, hz, dyn) => fn.addBrick(x, y, z, hx, hy, hz, dyn ? 1 : 0),
    addBoulder: (x, y, z, vx, vy, vz, r) => fn.addBoulder(x, y, z, vx, vy, vz, r),
    remove: (h) => fn.remove(h),
    get count() { return fn.renderCount(); }, // bodies + ragdoll bones (for render/snapshot)
    get bodyCount() { return fn.bodyCount(); },
    get intents() { sync(); return intentView; },
    get transforms() { sync(); return xfView; },
    step(dt, subSteps = 4) { fn.step(dt, subSteps); },
    // begin-touch contacts from the last step: {count, pairs} where pairs[i*2],
    // pairs[i*2+1] are the two body handles that started touching.
    contacts() { sync(); return { count: fn.contactCount(), pairs: contactView }; },
    // closest-hit ray; returns the hit body handle or -1.
    raycast: (x0, y0, z0, x1, y1, z1) => fn.raycast(x0, y0, z0, x1, y1, z1),
    // radial-impulse explosion at (x,y,z) — physically blasts bodies outward
    explode: (x, y, z, radius, impulse = 6) => fn.explode(x, y, z, radius, impulse),
    // linear impulse on one body (e.g. cavalry charge knockback)
    impulse: (h, ix, iy, iz) => fn.impulse(h, ix, iy, iz),
    // trebuchet: jointed throwing arm; fire() whips it and releases a boulder at
    // the tip mid-swing; poll() returns the spawned boulder handle once.
    addTrebuchet: (x, z, yaw) => fn.addTrebuchet(x, z, yaw),
    trebuchetFire: (i, vx, vy, vz, r = 1.4) => fn.trebuchetFire(i, vx, vy, vz, r),
    trebuchetPoll: (i) => fn.trebuchetPoll(i),
    // battering ram: heavy sled that breaches wall bricks it slams into
    addRam: (x, z) => fn.addRam(x, z),
    setVelocity: (h, vx, vz) => fn.setVelocity(h, vx, vz),
    // spawn a jointed ragdoll (pooled/capped) at (x,y,z) flung at (vx,vy,vz).
    spawnRagdoll: (x, y, z, vx, vy, vz) => fn.spawnRagdoll(x, y, z, vx, vy, vz),
    setRagdollParams: (cap, life) => fn.setRagdollParams(cap, life),
    // build a castle centered at (cx,cz); gateDir picks the gate's z-side (-1/+1).
    buildFort: (cx, cz, halfSize, courses = 5, gateDir = -1) => fn.buildFort(cx, cz, halfSize, courses, gateDir),
    // city-building primitives: a running-bond wall segment, and a round building
    // (house/keep/curtain ring; optional doorway facing gateYaw)
    buildWall: (x0, z0, x1, z1, courses = 2, thick = 0.7) => fn.buildWall(x0, z0, x1, z1, courses, thick),
    buildRondel: (cx, cz, radius, sides, courses, gateYaw = 0, hasGate = false) => fn.buildRondel(cx, cz, radius, sides, courses, gateYaw, hasGate ? 1 : 0),
    // fill the transform buffer without stepping (e.g. show the fresh fort at lobby).
    sync: () => fn.sync(),
  };
}
