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

export const XF_STRIDE = 8; // x,y,z, qx,qy,qz,qw, kind

export async function createArena({ maxBodies = 20000, seed = 1 } = {}) {
  const { Module } = await loadArena();
  const c = (name, ret, args) => Module.cwrap(name, ret, args);
  const fn = {
    reset: c('arena_reset', null, ['number', 'number']),
    createGround: c('arena_create_ground', null, ['number', 'number']),
    addSoldier: c('arena_add_soldier', 'number', ['number', 'number']),
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
    addSoldier: (x, z) => fn.addSoldier(x, z),
    addBrick: (x, y, z, hx, hy, hz, dyn) => fn.addBrick(x, y, z, hx, hy, hz, dyn ? 1 : 0),
    addBoulder: (x, y, z, vx, vy, vz, r) => fn.addBoulder(x, y, z, vx, vy, vz, r),
    remove: (h) => fn.remove(h),
    get count() { return fn.bodyCount(); },
    get intents() { sync(); return intentView; },
    get transforms() { sync(); return xfView; },
    step(dt, subSteps = 4) { fn.step(dt, subSteps); },
    // begin-touch contacts from the last step: {count, pairs} where pairs[i*2],
    // pairs[i*2+1] are the two body handles that started touching.
    contacts() { sync(); return { count: fn.contactCount(), pairs: contactView }; },
    // closest-hit ray; returns the hit body handle or -1.
    raycast: (x0, y0, z0, x1, y1, z1) => fn.raycast(x0, y0, z0, x1, y1, z1),
  };
}
