// box3d <-> Rome Arena glue, compiled to WASM (see physics/build.sh).
// Phase 1: the smallest possible thing that proves the toolchain works —
// create a world, drop a 1m cube on a static ground box, step it, read its
// height. No game logic yet; sim.js is untouched. Later phases grow this into
// the full batch API (soldiers/bricks/boulders + shared-HEAP transform buffer).
#include <box3d/box3d.h>
#include <emscripten.h>

static b3WorldId g_world;
static b3BodyId g_box;

// Single-threaded world (workerCount=1) so the wasm build needs no pthreads /
// SharedArrayBuffer / COOP-COEP headers. Ground's top surface sits at y=0.
EMSCRIPTEN_KEEPALIVE
void arena_create_world(void) {
  b3WorldDef wd = b3DefaultWorldDef();
  wd.gravity = (b3Vec3){ 0.0f, -10.0f, 0.0f };
  wd.workerCount = 1;
  g_world = b3CreateWorld(&wd);

  b3BodyDef gd = b3DefaultBodyDef();
  gd.type = b3_staticBody;
  gd.position = (b3Pos){ 0.0f, -1.0f, 0.0f };
  b3BodyId ground = b3CreateBody(g_world, &gd);
  b3BoxHull gh = b3MakeBoxHull(50.0f, 1.0f, 50.0f);
  b3ShapeDef gsd = b3DefaultShapeDef();
  b3CreateHullShape(ground, &gsd, &gh.base);
}

// Spawn a 0.5m half-extent dynamic cube at height y.
EMSCRIPTEN_KEEPALIVE
void arena_drop_test_box(float y) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ 0.0f, y, 0.0f };
  g_box = b3CreateBody(g_world, &bd);
  b3BoxHull bh = b3MakeBoxHull(0.5f, 0.5f, 0.5f);
  b3ShapeDef bsd = b3DefaultShapeDef();
  bsd.density = 1.0f;
  b3CreateHullShape(g_box, &bsd, &bh.base);
}

EMSCRIPTEN_KEEPALIVE
void arena_step(float dt, int subSteps) {
  b3World_Step(g_world, dt, subSteps);
}

EMSCRIPTEN_KEEPALIVE
float arena_get_test_y(void) {
  return (float) b3Body_GetPosition(g_box).y;
}

EMSCRIPTEN_KEEPALIVE
void arena_destroy_world(void) {
  b3DestroyWorld(g_world);
}
