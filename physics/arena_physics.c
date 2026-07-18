// box3d <-> Rome Arena glue, compiled to WASM (see physics/build.sh).
//
// The JS<->WASM boundary is BATCH-oriented: JS never calls per body. Instead it
// writes all soldier intents into one shared HEAP buffer, calls arena_step once
// (apply intents -> step world -> sync transforms), then reads every body's
// transform from a second shared HEAP buffer in a single pass. Bodies are
// addressed by a stable integer handle (index into the tables below).
//
// Phase 1 (kept): create_world / drop_test_box / get_test_y smoke API.
// Phase 2 (this): reset + ground + soldier/brick/boulder bodies + intent/xform
//                 buffers + step. sim.js still owns gameplay; this is a shadow
//                 world used to design the boundary and benchmark body counts.
#include <box3d/box3d.h>
#include <emscripten.h>
#include <stdlib.h>

// ---- soldier capsule dimensions (upright, planar battle) ----
#define SOL_RADIUS 0.35f
#define SOL_LOW    0.40f
#define SOL_HIGH   1.05f
#define SOL_DENSITY 1.0f

// body kinds (also written into the transform buffer's flags slot)
enum { KIND_DEAD = 0, KIND_SOLDIER = 1, KIND_BRICK = 2, KIND_BOULDER = 3, KIND_STATIC = 4 };

// floats per body in the transform buffer: x,y,z, qx,qy,qz,qw, flags
#define XF_STRIDE 8

static b3WorldId g_world;
static b3BodyId* g_bodies = NULL;
static unsigned char* g_kind = NULL;
static float* g_xf = NULL;      // transform out buffer  (XF_STRIDE * cap)
static float* g_intent = NULL;  // soldier intent buffer (2 * cap): desired vx,vz
static int g_cap = 0;
static int g_count = 0;

// ---------------- Phase 1 smoke API (unchanged) ----------------
static b3BodyId g_box;

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
float arena_get_test_y(void) { return (float) b3Body_GetPosition(g_box).y; }

EMSCRIPTEN_KEEPALIVE
void arena_destroy_world(void) {
  if (b3World_IsValid(g_world)) b3DestroyWorld(g_world);
}

// ---------------- Phase 2 batch API ----------------

// (Re)create the world and (re)allocate the body tables for up to maxBodies.
// seed is reserved for later deterministic body creation; unused for now.
EMSCRIPTEN_KEEPALIVE
void arena_reset(int seed, int maxBodies) {
  (void) seed;
  if (b3World_IsValid(g_world)) b3DestroyWorld(g_world);

  b3WorldDef wd = b3DefaultWorldDef();
  wd.gravity = (b3Vec3){ 0.0f, -10.0f, 0.0f };
  wd.workerCount = 1;
  wd.enableSleep = true;
  g_world = b3CreateWorld(&wd);

  free(g_bodies); free(g_kind); free(g_xf); free(g_intent);
  g_cap = maxBodies;
  g_count = 0;
  g_bodies = (b3BodyId*) malloc(sizeof(b3BodyId) * g_cap);
  g_kind = (unsigned char*) calloc(g_cap, 1);
  g_xf = (float*) calloc(g_cap * XF_STRIDE, sizeof(float));
  g_intent = (float*) calloc(g_cap * 2, sizeof(float));
}

static int push_body(b3BodyId id, unsigned char kind) {
  if (g_count >= g_cap) return -1;
  int h = g_count++;
  g_bodies[h] = id;
  g_kind[h] = kind;
  return h;
}

// Static ground plane (top at y=0) plus a perimeter wall ring so bodies can't
// leave the field. w,d are the full field width/depth (FIELD_W, FIELD_D).
EMSCRIPTEN_KEEPALIVE
void arena_create_ground(float w, float d) {
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.baseMaterial.friction = 0.8f;

  b3BodyDef gd = b3DefaultBodyDef();
  gd.type = b3_staticBody;
  gd.position = (b3Pos){ 0.0f, -1.0f, 0.0f };
  b3BodyId ground = b3CreateBody(g_world, &gd);
  b3BoxHull gh = b3MakeBoxHull(w, 1.0f, d);
  b3CreateHullShape(ground, &sd, &gh.base);
  push_body(ground, KIND_STATIC);

  const float hw = w * 0.5f, hd = d * 0.5f, t = 1.0f, hh = 4.0f;
  const float px[4] = { hw + t, -hw - t, 0.0f, 0.0f };
  const float pz[4] = { 0.0f, 0.0f, hd + t, -hd - t };
  const float ex[4] = { t, t, hw + t, hw + t };
  const float ez[4] = { hd + t, hd + t, t, t };
  for (int i = 0; i < 4; i++) {
    b3BodyDef bd = b3DefaultBodyDef();
    bd.type = b3_staticBody;
    bd.position = (b3Pos){ px[i], hh * 0.5f, pz[i] };
    b3BodyId wall = b3CreateBody(g_world, &bd);
    b3BoxHull wh = b3MakeBoxHull(ex[i], hh, ez[i]);
    b3CreateHullShape(wall, &sd, &wh.base);
    push_body(wall, KIND_STATIC);
  }
}

// Upright dynamic capsule; rotation fully locked (facing is owned by JS), so it
// stays standing and slides via velocity intents while still colliding/jostling.
EMSCRIPTEN_KEEPALIVE
int arena_add_soldier(float x, float z) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ x, 0.0f, z };
  bd.motionLocks.angularX = true;
  bd.motionLocks.angularY = true;
  bd.motionLocks.angularZ = true;
  bd.linearDamping = 0.1f;
  b3BodyId id = b3CreateBody(g_world, &bd);

  b3Capsule cap = { { 0.0f, SOL_LOW, 0.0f }, { 0.0f, SOL_HIGH, 0.0f }, SOL_RADIUS };
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = SOL_DENSITY;
  sd.baseMaterial.friction = 0.4f;
  b3CreateCapsuleShape(id, &sd, &cap);
  return push_body(id, KIND_SOLDIER);
}

EMSCRIPTEN_KEEPALIVE
int arena_add_brick(float x, float y, float z, float hx, float hy, float hz, int isDynamic) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = isDynamic ? b3_dynamicBody : b3_staticBody;
  bd.position = (b3Pos){ x, y, z };
  b3BodyId id = b3CreateBody(g_world, &bd);
  b3BoxHull hull = b3MakeBoxHull(hx, hy, hz);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = 4.0f;
  sd.baseMaterial.friction = 0.75f;
  b3CreateHullShape(id, &sd, &hull.base);
  return push_body(id, isDynamic ? KIND_BRICK : KIND_STATIC);
}

// Fast dynamic rock (CCD bullet) launched with an initial velocity.
EMSCRIPTEN_KEEPALIVE
int arena_add_boulder(float x, float y, float z, float vx, float vy, float vz, float radius) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ x, y, z };
  bd.isBullet = true;
  bd.linearVelocity = (b3Vec3){ vx, vy, vz };
  b3BodyId id = b3CreateBody(g_world, &bd);
  b3HullData* rock = b3CreateRock(radius);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = 13.0f;
  sd.baseMaterial.friction = 0.6f;
  b3CreateHullShape(id, &sd, rock);
  b3DestroyHull(rock);
  return push_body(id, KIND_BOULDER);
}

EMSCRIPTEN_KEEPALIVE
void arena_remove(int h) {
  if (h < 0 || h >= g_count || g_kind[h] == KIND_DEAD) return;
  if (b3Body_IsValid(g_bodies[h])) b3DestroyBody(g_bodies[h]);
  g_kind[h] = KIND_DEAD;
}

EMSCRIPTEN_KEEPALIVE int arena_body_count(void) { return g_count; }
EMSCRIPTEN_KEEPALIVE float* arena_transform_ptr(void) { return g_xf; }
EMSCRIPTEN_KEEPALIVE float* arena_intent_ptr(void) { return g_intent; }

// One boundary crossing per tick: apply the intent buffer to soldier bodies
// (preserving vertical velocity so gravity/knockback still work), step the
// world, then write every live body's transform into the shared buffer.
EMSCRIPTEN_KEEPALIVE
void arena_step(float dt, int subSteps) {
  for (int h = 0; h < g_count; h++) {
    if (g_kind[h] != KIND_SOLDIER) continue;
    b3Vec3 v = b3Body_GetLinearVelocity(g_bodies[h]);
    b3Body_SetLinearVelocity(g_bodies[h], (b3Vec3){ g_intent[h * 2], v.y, g_intent[h * 2 + 1] });
  }

  b3World_Step(g_world, dt, subSteps);

  for (int h = 0; h < g_count; h++) {
    float* o = g_xf + h * XF_STRIDE;
    if (g_kind[h] == KIND_DEAD) { o[7] = KIND_DEAD; continue; }
    b3WorldTransform t = b3Body_GetTransform(g_bodies[h]);
    o[0] = (float) t.p.x; o[1] = (float) t.p.y; o[2] = (float) t.p.z;
    o[3] = t.q.v.x; o[4] = t.q.v.y; o[5] = t.q.v.z; o[6] = t.q.s;
    o[7] = (float) g_kind[h];
  }
}
