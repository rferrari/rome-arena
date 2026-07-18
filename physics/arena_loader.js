// Dual-host loader for the box3d physics WASM module. The emscripten output
// (arena.mjs, MODULARIZE + EXPORT_ES6) is a plain ES module that instantiates
// the same way under Bun (server) and the browser (solo/render) — it locates
// arena.wasm via import.meta.url, so no bundler and no special headers.
//
// Phase 1 exposes only the drop-box smoke API; later phases add the batch API.
let modPromise = null;

export async function loadArena() {
  if (!modPromise) {
    const { default: createArenaModule } = await import('./arena.mjs');
    modPromise = createArenaModule();
  }
  const Module = await modPromise;
  return {
    Module,
    createWorld: Module.cwrap('arena_create_world', null, []),
    dropTestBox: Module.cwrap('arena_drop_test_box', null, ['number']),
    step: Module.cwrap('arena_step', null, ['number', 'number']),
    getTestY: Module.cwrap('arena_get_test_y', 'number', []),
    destroyWorld: Module.cwrap('arena_destroy_world', null, []),
  };
}
