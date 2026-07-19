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
#include <stdint.h>
#include <math.h>
#include "human.h" // box3d's jointed 14-bone ragdoll (shared/human.c)

// human.c's RandomFloat helpers (utils.h) need this global, normally in utils.c.
// Define it here so we don't pull in utils.c (which drags in threading code).
uint32_t g_randomSeed = 12345u;

// ---- soldier capsule dimensions (upright, planar battle) ----
#define SOL_RADIUS 0.35f
#define SOL_LOW    0.40f
#define SOL_HIGH   1.05f
#define SOL_DENSITY 1.0f

// body kinds (also written into the transform buffer's flags slot)
enum { KIND_DEAD = 0, KIND_SOLDIER = 1, KIND_BRICK = 2, KIND_BOULDER = 3, KIND_STATIC = 4, KIND_RAGDOLL = 5, KIND_RUBBLE = 6,
       KIND_ENGINE = 7 /* trebuchet frame/arm */, KIND_RAM = 8 };

// collision categories. Ragdolls (dead soldiers) collide only with the world/rubble
// so corpses fall realistically without blocking the living battle.
#define CAT_STATIC  0x1u
#define CAT_SOLDIER 0x2u
#define CAT_BOULDER 0x4u
#define CAT_BRICK   0x8u
#define CAT_RAGDOLL 0x10u
#define MASK_ALL    0xFFFFFFFFu
#define PI_F 3.14159265358979323846f

// floats per body in the transform buffer: x,y,z, qx,qy,qz,qw, flags, hx,hy,hz
// (half-extents let the renderer scale instanced bricks without a side table)
#define XF_STRIDE 11

static b3WorldId g_world;
static b3BodyId* g_bodies = NULL;
static unsigned char* g_kind = NULL;
static float* g_xf = NULL;      // transform out buffer  (XF_STRIDE * cap)
static float* g_intent = NULL;  // soldier intent buffer (2 * cap): desired vx,vz
static float* g_ext = NULL;     // per-body half-extents (3 * cap) for rendering
static int g_cap = 0;
static int g_count = 0;

// contact begin-touch pairs drained each step (handleA, handleB), for JS damage
#define MAX_CONTACTS 8192
static int* g_contacts = NULL;
static int g_contactCount = 0;

static void write_transforms(void); // defined after arena_step
static void do_breach(float x, float y, float z, float r); // boulder-blasts standing walls to rubble
static void treb_step(void); // trebuchet arm state machines (defined with the engines)
static int g_trebCount;     // live trebuchets (definition with the engine code)
static int g_towerCount;    // live siege towers (definition with the engine code)
void arena_set_velocity(int h, float vx, float vz); // defined with the ram; used by the tower

// ---- jointed ragdoll pool (real box3d Humans, spawned on death, capped) ----
#define RAGDOLL_MAX 128
// per-bone render data: the capsule's local midpoint + a quaternion aligning the
// render capsule's Y axis to the bone's capsule axis, so each bone draws as a
// correctly-placed, correctly-oriented capsule (the box3d human shape).
typedef struct { b3Vec3 mid; b3Quat align; float radius; float halfLen; int ok; } RagBone;
static Human g_rag[RAGDOLL_MAX];
static float g_ragBorn[RAGDOLL_MAX];
static RagBone g_ragBone[RAGDOLL_MAX][bone_count];
static int g_ragCap = 0, g_ragNext = 0;
static float g_ragLife = 5.0f, g_ragTime = 0.0f;
static int g_renderCount = 0; // bodies + active ragdoll bones written to the buffer

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

  free(g_bodies); free(g_kind); free(g_xf); free(g_intent); free(g_contacts); free(g_ext);
  g_cap = maxBodies;
  g_count = 0;
  g_contactCount = 0;
  g_bodies = (b3BodyId*) malloc(sizeof(b3BodyId) * g_cap);
  g_kind = (unsigned char*) calloc(g_cap, 1);
  g_xf = (float*) calloc(g_cap * XF_STRIDE, sizeof(float));
  g_intent = (float*) calloc(g_cap * 2, sizeof(float));
  g_contacts = (int*) calloc(MAX_CONTACTS * 2, sizeof(int));
  g_ext = (float*) calloc(g_cap * 3, sizeof(float));
  // old world's ragdoll bodies are gone with it — just forget them
  for (int i = 0; i < RAGDOLL_MAX; i++) g_rag[i].isSpawned = false;
  g_ragNext = 0; g_ragTime = 0.0f; g_renderCount = 0;
  g_trebCount = 0; // engines died with the old world too
  g_towerCount = 0;
}

EMSCRIPTEN_KEEPALIVE
void arena_set_ragdoll_params(int cap, float life) {
  g_ragCap = cap > RAGDOLL_MAX ? RAGDOLL_MAX : (cap < 0 ? 0 : cap);
  g_ragLife = life;
}

// Spawn a jointed ragdoll at (x,y,z) flung at (vx,vy,vz). Pooled + round-robin
// recycled at g_ragCap, so the body budget is bounded. Bones are refiltered so
// corpses fall on the ground/rubble but never block the living battle.
EMSCRIPTEN_KEEPALIVE
void arena_spawn_ragdoll(float x, float y, float z, float vx, float vy, float vz) {
  if (g_ragCap <= 0) return;
  int slot = g_ragNext % g_ragCap;
  g_ragNext++;
  if (g_rag[slot].isSpawned) DestroyHuman(&g_rag[slot]);
  Human* h = &g_rag[slot];
  for (int i = 0; i < (int) sizeof(Human); i++) ((char*) h)[i] = 0; // zero-init (required)
  CreateHuman(h, g_world, (b3Pos){ x, y, z }, 0.1f, 0.0f, 0.0f, slot + 1, (void*)(intptr_t)(-1), false);
  Human_SetVelocity(h, (b3Vec3){ vx, vy, vz });
  Human_ApplyRandomAngularImpulse(h, 8.0f);
  g_ragBorn[slot] = g_ragTime;
  for (int b = 0; b < bone_count; b++) {
    RagBone* rb = &g_ragBone[slot][b];
    rb->ok = 0;
    b3BodyId id = h->bones[b].bodyId;
    if (!b3Body_IsValid(id)) continue;
    b3ShapeId sh;
    if (b3Body_GetShapes(id, &sh, 1) != 1 || b3Shape_GetType(sh) != b3_capsuleShape) continue;
    b3Filter f = { CAT_RAGDOLL, CAT_STATIC | CAT_BRICK, -(slot + 1) };
    b3Shape_SetFilter(sh, f, false);
    b3Capsule c = b3Shape_GetCapsule(sh);
    b3Vec3 axis = b3Sub(c.center2, c.center1);
    float len = b3Length(axis);
    rb->mid = (b3Vec3){ (c.center1.x + c.center2.x) * 0.5f, (c.center1.y + c.center2.y) * 0.5f, (c.center1.z + c.center2.z) * 0.5f };
    rb->radius = c.radius; rb->halfLen = len * 0.5f; rb->ok = 1;
    // quaternion that rotates the render capsule's +Y onto this bone's capsule axis
    if (len < 1e-6f) { rb->align = b3Quat_identity; continue; }
    b3Vec3 d = b3Normalize(axis), up = { 0, 1, 0 };
    float dot = b3Dot(up, d);
    if (dot > 0.9999f) rb->align = b3Quat_identity;
    else if (dot < -0.9999f) rb->align = b3MakeQuatFromAxisAngle((b3Vec3){ 1, 0, 0 }, PI_F);
    else rb->align = b3MakeQuatFromAxisAngle(b3Normalize(b3Cross(up, d)), acosf(dot));
  }
}

// push a body and record its render half-extents in one go
static int push_body_ext(b3BodyId id, unsigned char kind, float hx, float hy, float hz) {
  if (g_count >= g_cap) return -1;
  int h = g_count++;
  g_bodies[h] = id;
  g_kind[h] = kind;
  g_ext[h * 3] = hx; g_ext[h * 3 + 1] = hy; g_ext[h * 3 + 2] = hz;
  return h;
}
static int push_body(b3BodyId id, unsigned char kind) { return push_body_ext(id, kind, 0, 0, 0); }

// Static ground plane (top at y=0) plus a perimeter wall ring so bodies can't
// leave the field. w,d are the full field width/depth (FIELD_W, FIELD_D).
EMSCRIPTEN_KEEPALIVE
void arena_create_ground(float w, float d) {
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.baseMaterial.friction = 0.8f;
  sd.filter.categoryBits = CAT_STATIC;
  sd.filter.maskBits = MASK_ALL;

  b3BodyDef gd = b3DefaultBodyDef();
  gd.type = b3_staticBody;
  gd.position = (b3Pos){ 0.0f, -1.0f, 0.0f };
  gd.userData = (void*)(intptr_t) g_count;
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
    bd.userData = (void*)(intptr_t) g_count;
    b3BodyId wall = b3CreateBody(g_world, &bd);
    b3BoxHull wh = b3MakeBoxHull(ex[i], hh, ez[i]);
    b3CreateHullShape(wall, &sd, &wh.base);
    push_body(wall, KIND_STATIC);
  }
}

// Upright dynamic capsule; rotation fully locked (facing is owned by JS), so it
// stays standing and slides via velocity intents while still colliding/jostling.
// y > 0 spawns the soldier elevated (e.g. garrison archers standing on wall crests —
// they rest on the static bricks and tumble down with them when the wall is breached).
EMSCRIPTEN_KEEPALIVE
int arena_add_soldier(float x, float y, float z) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ x, y, z };
  bd.motionLocks.angularX = true;
  bd.motionLocks.angularY = true;
  bd.motionLocks.angularZ = true;
  bd.linearDamping = 0.1f;
  bd.userData = (void*)(intptr_t) g_count;
  b3BodyId id = b3CreateBody(g_world, &bd);

  b3Capsule cap = { { 0.0f, SOL_LOW, 0.0f }, { 0.0f, SOL_HIGH, 0.0f }, SOL_RADIUS };
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = SOL_DENSITY;
  sd.baseMaterial.friction = 0.4f;
  sd.filter.categoryBits = CAT_SOLDIER;
  sd.filter.maskBits = CAT_STATIC | CAT_SOLDIER | CAT_BOULDER | CAT_BRICK; // not ragdolls
  b3CreateCapsuleShape(id, &sd, &cap);
  return push_body_ext(id, KIND_SOLDIER, SOL_RADIUS, (SOL_HIGH - SOL_LOW) * 0.5f, SOL_RADIUS);
}

EMSCRIPTEN_KEEPALIVE
int arena_add_brick(float x, float y, float z, float hx, float hy, float hz, int isDynamic) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = isDynamic ? b3_dynamicBody : b3_staticBody;
  bd.position = (b3Pos){ x, y, z };
  bd.userData = (void*)(intptr_t) g_count;
  b3BodyId id = b3CreateBody(g_world, &bd);
  b3BoxHull hull = b3MakeBoxHull(hx, hy, hz);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = 4.0f;
  sd.baseMaterial.friction = 0.75f;
  sd.filter.categoryBits = isDynamic ? CAT_BRICK : CAT_STATIC;
  sd.filter.maskBits = MASK_ALL;
  b3CreateHullShape(id, &sd, &hull.base);
  return push_body_ext(id, isDynamic ? KIND_BRICK : KIND_STATIC, hx, hy, hz);
}

// Fast dynamic rock (CCD bullet) launched with an initial velocity.
EMSCRIPTEN_KEEPALIVE
int arena_add_boulder(float x, float y, float z, float vx, float vy, float vz, float radius) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ x, y, z };
  bd.isBullet = true;
  bd.linearVelocity = (b3Vec3){ vx, vy, vz };
  bd.userData = (void*)(intptr_t) g_count;
  b3BodyId id = b3CreateBody(g_world, &bd);
  b3HullData* rock = b3CreateRock(radius);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = 13.0f;
  sd.baseMaterial.friction = 0.6f;
  sd.filter.categoryBits = CAT_BOULDER;
  sd.filter.maskBits = CAT_STATIC | CAT_SOLDIER | CAT_BRICK | CAT_BOULDER; // not corpses
  // only boulders enable contact events; box3d fires begin-touch if EITHER shape
  // enables it, so boulder-vs-soldier/wall reports without the soldier-soldier flood.
  sd.enableContactEvents = true;
  b3CreateHullShape(id, &sd, rock);
  b3DestroyHull(rock);
  return push_body_ext(id, KIND_BOULDER, radius, radius, radius);
}

EMSCRIPTEN_KEEPALIVE
void arena_remove(int h) {
  if (h < 0 || h >= g_count || g_kind[h] == KIND_DEAD) return;
  if (b3Body_IsValid(g_bodies[h])) b3DestroyBody(g_bodies[h]);
  g_kind[h] = KIND_DEAD;
}

EMSCRIPTEN_KEEPALIVE int arena_body_count(void) { return g_count; }
EMSCRIPTEN_KEEPALIVE int arena_render_count(void) { return g_renderCount; } // bodies + ragdoll bones
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

  treb_step(); // swing/release/reset the trebuchet arms

  b3World_Step(g_world, dt, subSteps);

  // drain begin-touch contacts into the shared int buffer as (handleA, handleB),
  // and blast standing walls into rubble where a boulder strikes.
  b3ContactEvents ce = b3World_GetContactEvents(g_world);
  g_contactCount = 0;
  for (int i = 0; i < ce.beginCount && g_contactCount < MAX_CONTACTS; i++) {
    int ha = (int)(intptr_t) b3Body_GetUserData(b3Shape_GetBody(ce.beginEvents[i].shapeIdA));
    int hb = (int)(intptr_t) b3Body_GetUserData(b3Shape_GetBody(ce.beginEvents[i].shapeIdB));
    int ka = g_kind[ha], kb = g_kind[hb];
    // battering ram: a fast ram slamming a wall brick breaches it (handled fully
    // here in C — ram pairs are never reported to JS).
    if (ka == KIND_RAM || kb == KIND_RAM) {
      const int ram = ka == KIND_RAM ? ha : hb, oth = ka == KIND_RAM ? hb : ha;
      if (g_kind[oth] == KIND_BRICK) {
        b3Vec3 v = b3Body_GetLinearVelocity(g_bodies[ram]);
        if (v.x * v.x + v.z * v.z > 2.25f) { // > 1.5 m/s: the blow lands
          b3WorldTransform t = b3Body_GetTransform(g_bodies[oth]);
          do_breach((float) t.p.x, (float) t.p.y, (float) t.p.z, 3.2f);
        }
      }
      continue;
    }
    // flying rubble: only fast rubble-vs-soldier pairs matter (falling masonry
    // CRUSHES soldiers); everything else rubble touches is noise — drop it.
    if (ka == KIND_RUBBLE || kb == KIND_RUBBLE) {
      int rub = ka == KIND_RUBBLE ? ha : hb, oth = ka == KIND_RUBBLE ? kb : ka;
      if (oth != KIND_SOLDIER) continue;
      b3Vec3 v = b3Body_GetLinearVelocity(g_bodies[rub]);
      if (v.x * v.x + v.y * v.y + v.z * v.z < 16.0f) continue; // < 4 m/s: harmless
    }
    g_contacts[g_contactCount * 2] = ha;
    g_contacts[g_contactCount * 2 + 1] = hb;
    g_contactCount++;
    if ((ka == KIND_BOULDER && kb == KIND_BRICK) || (ka == KIND_BRICK && kb == KIND_BOULDER)) {
      int brick = (ka == KIND_BRICK) ? ha : hb;
      b3WorldTransform t = b3Body_GetTransform(g_bodies[brick]);
      do_breach((float) t.p.x, (float) t.p.y, (float) t.p.z, 4.0f);
    }
  }

  g_ragTime += dt; // age ragdolls; recycle expired ones
  for (int i = 0; i < g_ragCap; i++)
    if (g_rag[i].isSpawned && g_ragTime - g_ragBorn[i] > g_ragLife) { DestroyHuman(&g_rag[i]); g_rag[i].isSpawned = false; }

  write_transforms();
}

// Write every live body's transform (pos + quat), kind flag, and render
// half-extents into the shared buffer, then append the active ragdoll bones after
// them (KIND_RAGDOLL). g_renderCount covers both. Split out so it can also run
// without a physics step (arena_sync), e.g. to fill the buffer for the lobby.
static void write_transforms(void) {
  int rc = 0;
  for (int h = 0; h < g_count; h++, rc++) {
    float* o = g_xf + h * XF_STRIDE;
    if (g_kind[h] == KIND_DEAD) { o[7] = KIND_DEAD; continue; }
    b3WorldTransform t = b3Body_GetTransform(g_bodies[h]);
    o[0] = (float) t.p.x; o[1] = (float) t.p.y; o[2] = (float) t.p.z;
    o[3] = t.q.v.x; o[4] = t.q.v.y; o[5] = t.q.v.z; o[6] = t.q.s;
    o[7] = (float) g_kind[h];
    o[8] = g_ext[h * 3]; o[9] = g_ext[h * 3 + 1]; o[10] = g_ext[h * 3 + 2];
  }
  for (int i = 0; i < g_ragCap; i++) {
    if (!g_rag[i].isSpawned) continue;
    for (int b = 0; b < bone_count; b++) {
      RagBone* rb = &g_ragBone[i][b];
      if (!rb->ok || rc >= g_cap) continue;
      b3BodyId id = g_rag[i].bones[b].bodyId;
      if (!b3Body_IsValid(id)) continue;
      float* o = g_xf + rc * XF_STRIDE;
      b3WorldTransform t = b3Body_GetTransform(id);
      // capsule world centre + orientation (bodyPos + bodyRot*mid, bodyRot*align)
      b3Vec3 wp = b3Add((b3Vec3){ (float) t.p.x, (float) t.p.y, (float) t.p.z }, b3RotateVector(t.q, rb->mid));
      b3Quat wq = b3MulQuat(t.q, rb->align);
      o[0] = wp.x; o[1] = wp.y; o[2] = wp.z;
      o[3] = wq.v.x; o[4] = wq.v.y; o[5] = wq.v.z; o[6] = wq.s;
      o[7] = (float) KIND_RAGDOLL;
      o[8] = rb->radius; o[9] = rb->halfLen; o[10] = rb->radius;
      rc++;
    }
  }
  g_renderCount = rc;
}

// Fill the transform buffer without advancing physics (fresh fort at lobby time).
EMSCRIPTEN_KEEPALIVE void arena_sync(void) { write_transforms(); }

// Convert standing (static) wall bricks within radius r of an impact into dynamic
// rubble and kick them outward, so a boulder punches a breach instead of nudging
// one brick. Rubble is KIND_RUBBLE so the flow field stops treating it as a wall.
static void do_breach(float x, float y, float z, float r) {
  const float r2 = r * r;
  for (int h = 0; h < g_count; h++) {
    if (g_kind[h] != KIND_BRICK) continue; // only standing (static) walls
    b3WorldTransform t = b3Body_GetTransform(g_bodies[h]);
    const float dx = (float) t.p.x - x, dy = (float) t.p.y - y, dz = (float) t.p.z - z;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    b3Body_SetType(g_bodies[h], b3_dynamicBody);
    b3Body_SetAwake(g_bodies[h], true);
    const float d = sqrtf(dx * dx + dz * dz) + 0.01f;
    b3Body_ApplyLinearImpulseToCenter(g_bodies[h], (b3Vec3){ dx / d * 40.0f, 25.0f, dz / d * 40.0f }, true);
    g_kind[h] = KIND_RUBBLE;
    // flying rubble reports contacts so it can crush soldiers (filtered in the drain)
    b3ShapeId sh;
    if (b3Body_GetShapes(g_bodies[h], &sh, 1) == 1) b3Shape_EnableContactEvents(sh, true);
  }
}

// Contacts drained during the last arena_step: a flat (handleA, handleB) int
// buffer of length 2*arena_contact_count(). JS maps handles -> game objects.
EMSCRIPTEN_KEEPALIVE int arena_contact_count(void) { return g_contactCount; }
EMSCRIPTEN_KEEPALIVE int* arena_contacts_ptr(void) { return g_contacts; }

// ---- jointed siege engines ----
// Trebuchet: a static frame post and a throwing arm on a REVOLUTE JOINT, swung by
// the joint motor. The arm physically whips over the top; at the release angle a
// boulder spawns at the arm tip (with the launch velocity JS computed). States:
// 0 idle (held cocked) -> 1 firing (motor whips) -> 2 resetting (winch back).
#define TREB_MAX 32
typedef struct { b3BodyId arm; b3JointId joint; int state; float vx, vy, vz, radius; int spawned; } Treb;
static Treb g_treb[TREB_MAX]; // g_trebCount declared with the top globals

EMSCRIPTEN_KEEPALIVE
int arena_add_trebuchet(float x, float z, float yaw) {
  if (g_trebCount >= TREB_MAX) return -1;
  const b3Quat yawQ = b3MakeQuatFromAxisAngle((b3Vec3){ 0, 1, 0 }, yaw);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.baseMaterial.friction = 0.6f;
  sd.filter.categoryBits = CAT_STATIC;
  sd.filter.maskBits = MASK_ALL & ~CAT_RAGDOLL;

  // frame post (static), pivot at its top (y = 3.2)
  b3BodyDef pd = b3DefaultBodyDef();
  pd.type = b3_staticBody;
  pd.position = (b3Pos){ x, 1.6f, z };
  pd.rotation = yawQ;
  pd.userData = (void*)(intptr_t) g_count;
  b3BodyId post = b3CreateBody(g_world, &pd);
  b3BoxHull ph = b3MakeBoxHull(0.35f, 1.6f, 0.35f);
  b3CreateHullShape(post, &sd, &ph.base);
  push_body_ext(post, KIND_ENGINE, 0.35f, 1.6f, 0.35f);

  // throwing arm (dynamic), long axis = local Z, pivoted 1.1 from its butt end,
  // created cocked (tip low behind the frame)
  const float REST = 2.4f;
  const b3Quat armQ = b3MulQuat(yawQ, b3MakeQuatFromAxisAngle((b3Vec3){ 1, 0, 0 }, REST));
  const b3Vec3 off = b3RotateVector(armQ, (b3Vec3){ 0, 0, 1.1f });
  b3BodyDef ad = b3DefaultBodyDef();
  ad.type = b3_dynamicBody;
  ad.position = (b3Pos){ x + off.x, 3.2f + off.y, z + off.z };
  ad.rotation = armQ;
  ad.userData = (void*)(intptr_t) g_count;
  b3BodyId arm = b3CreateBody(g_world, &ad);
  b3BoxHull ah = b3MakeBoxHull(0.15f, 0.15f, 2.2f);
  b3ShapeDef asd = b3DefaultShapeDef();
  asd.density = 2.0f;
  asd.filter.categoryBits = CAT_STATIC; // arm shouldn't shove the crew around
  asd.filter.maskBits = 0;              // ...or collide at all; the joint drives it
  b3CreateHullShape(arm, &asd, &ah.base);
  push_body_ext(arm, KIND_ENGINE, 0.15f, 0.15f, 2.2f);

  // hinge: rotates about the joint frame z-axis; rotY(90°) maps z onto local X,
  // the horizontal axis perpendicular to the throw direction
  const b3Quat qF = b3MakeQuatFromAxisAngle((b3Vec3){ 0, 1, 0 }, 0.5f * PI_F);
  b3RevoluteJointDef jd = b3DefaultRevoluteJointDef();
  jd.base.bodyIdA = post;
  jd.base.bodyIdB = arm;
  jd.base.localFrameA = (b3Transform){ { 0, 1.6f, 0 }, qF };
  jd.base.localFrameB = (b3Transform){ { 0, 0, -1.1f }, qF };
  jd.enableLimit = true;
  jd.lowerAngle = -3.05f;
  jd.upperAngle = 0.05f;
  jd.enableMotor = true;
  jd.maxMotorTorque = 30000.0f;
  jd.motorSpeed = 0.0f;
  b3JointId joint = b3CreateRevoluteJoint(g_world, &jd);

  Treb* t = &g_treb[g_trebCount];
  t->arm = arm; t->joint = joint; t->state = 0; t->spawned = -1;
  return g_trebCount++;
}

// Kick off a throw; the boulder (radius r, launch velocity v) releases mid-swing.
EMSCRIPTEN_KEEPALIVE
void arena_trebuchet_fire(int i, float vx, float vy, float vz, float radius) {
  if (i < 0 || i >= g_trebCount || g_treb[i].state != 0) return;
  Treb* t = &g_treb[i];
  t->vx = vx; t->vy = vy; t->vz = vz; t->radius = radius;
  t->state = 1;
  b3RevoluteJoint_SetMotorSpeed(t->joint, -10.0f);
}

// Returns the boulder handle spawned by trebuchet i since the last poll (else -1).
EMSCRIPTEN_KEEPALIVE
int arena_trebuchet_poll(int i) {
  if (i < 0 || i >= g_trebCount) return -1;
  int h = g_treb[i].spawned;
  g_treb[i].spawned = -1;
  return h;
}

static void treb_step(void) {
  for (int i = 0; i < g_trebCount; i++) {
    Treb* t = &g_treb[i];
    if (t->state == 0) continue;
    const float a = b3RevoluteJoint_GetAngle(t->joint);
    if (t->state == 1 && a < -2.2f) { // release point: spawn the boulder at the arm tip
      b3WorldTransform w = b3Body_GetTransform(t->arm);
      b3Vec3 tip = b3RotateVector(w.q, (b3Vec3){ 0, 0, 2.2f });
      t->spawned = arena_add_boulder((float) w.p.x + tip.x, (float) w.p.y + tip.y + 0.5f,
                                     (float) w.p.z + tip.z, t->vx, t->vy, t->vz, t->radius);
      t->state = 2;
      b3RevoluteJoint_SetMotorSpeed(t->joint, 2.5f); // winch the arm back
    } else if (t->state == 2 && a > -0.05f) {
      t->state = 0;
      b3RevoluteJoint_SetMotorSpeed(t->joint, 0.0f); // hold cocked
    }
  }
}

// Siege tower: a tall wheeled tower (dynamic, upright-locked, driven by JS) with a
// drawbridge plank on a REVOLUTE JOINT at its top front. The bridge is held raised
// (vertical) until arena_tower_drop() swings it down flat over the wall. State:
// 0 rolling/raised -> 1 dropping.
#define TOWER_MAX 8
typedef struct { int handle; b3JointId hinge; int state; } Tower;
static Tower g_tower[TOWER_MAX]; // g_towerCount declared with the top globals

EMSCRIPTEN_KEEPALIVE
int arena_add_tower(float x, float z, float yaw) {
  if (g_towerCount >= TOWER_MAX) return -1;
  const b3Quat yawQ = b3MakeQuatFromAxisAngle((b3Vec3){ 0, 1, 0 }, yaw);

  // tower body: tall box, angular-locked so it stays upright and only translates
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ x, 4.0f, z };
  bd.rotation = yawQ;
  bd.motionLocks.angularX = true; bd.motionLocks.angularY = true; bd.motionLocks.angularZ = true;
  bd.linearDamping = 1.0f;
  bd.userData = (void*)(intptr_t) g_count;
  b3BodyId body = b3CreateBody(g_world, &bd);
  b3BoxHull bh = b3MakeBoxHull(1.6f, 4.0f, 1.6f);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = 6.0f;
  // collides only with walls/ground — it rolls THROUGH the crowd to reach the wall
  // instead of stalling against a wall of soldiers (JS stops it at the target)
  sd.filter.categoryBits = CAT_BOULDER;
  sd.filter.maskBits = CAT_STATIC | CAT_BRICK;
  b3CreateHullShape(body, &sd, &bh.base);
  int handle = push_body_ext(body, KIND_ENGINE, 1.6f, 4.0f, 1.6f);

  // drawbridge plank, long axis = local Z, pivoted at its butt (local Z = -2), created
  // RAISED (rotated up about the hinge X axis so it stands vertical against the front)
  const float RAISED = -1.5f;
  const b3Quat brQ = b3MulQuat(yawQ, b3MakeQuatFromAxisAngle((b3Vec3){ 1, 0, 0 }, RAISED));
  const b3Vec3 hinge = b3RotateVector(yawQ, (b3Vec3){ 0, 4.0f, 1.6f }); // tower top-front, local
  const b3Vec3 toC = b3RotateVector(brQ, (b3Vec3){ 0, 0, 2.0f });        // butt -> plank centre
  b3BodyDef pd = b3DefaultBodyDef();
  pd.type = b3_dynamicBody;
  pd.position = (b3Pos){ x + hinge.x + toC.x, 4.0f + hinge.y + toC.y, z + hinge.z + toC.z };
  pd.rotation = brQ;
  pd.userData = (void*)(intptr_t) g_count;
  b3BodyId bridge = b3CreateBody(g_world, &pd);
  b3BoxHull ph = b3MakeBoxHull(1.4f, 0.12f, 2.0f);
  b3ShapeDef psd = b3DefaultShapeDef();
  psd.density = 3.0f;
  psd.filter.categoryBits = CAT_BOULDER;
  psd.filter.maskBits = CAT_STATIC | CAT_BRICK;
  b3CreateHullShape(bridge, &psd, &ph.base);
  push_body_ext(bridge, KIND_ENGINE, 1.4f, 0.12f, 2.0f);

  // hinge about local X (horizontal, perpendicular to travel); rotY(90°) maps the
  // joint z-axis onto local X, same trick as the trebuchet arm
  const b3Quat qF = b3MakeQuatFromAxisAngle((b3Vec3){ 0, 1, 0 }, 0.5f * PI_F);
  b3RevoluteJointDef jd = b3DefaultRevoluteJointDef();
  jd.base.bodyIdA = body;
  jd.base.bodyIdB = bridge;
  jd.base.localFrameA = (b3Transform){ { 0, 4.0f, 1.6f }, qF };
  jd.base.localFrameB = (b3Transform){ { 0, 0, -2.0f }, qF };
  jd.enableLimit = true;
  jd.lowerAngle = RAISED - 0.05f;  // up
  jd.upperAngle = 0.05f;           // flat forward
  jd.enableMotor = true;
  jd.maxMotorTorque = 4000.0f;
  jd.motorSpeed = -1.0f;           // hold up against the lower limit
  b3JointId hinge_j = b3CreateRevoluteJoint(g_world, &jd);

  Tower* t = &g_tower[g_towerCount];
  t->handle = handle; t->hinge = hinge_j; t->state = 0;
  return g_towerCount++;
}

EMSCRIPTEN_KEEPALIVE
int arena_tower_handle(int i) { return (i < 0 || i >= g_towerCount) ? -1 : g_tower[i].handle; }

// drive the tower body horizontally (JS steers it toward the wall)
EMSCRIPTEN_KEEPALIVE
void arena_tower_drive(int i, float vx, float vz) {
  if (i < 0 || i >= g_towerCount) return;
  arena_set_velocity(g_tower[i].handle, vx, vz);
}

// release the drawbridge: swing it down flat over the wall
EMSCRIPTEN_KEEPALIVE
void arena_tower_drop(int i) {
  if (i < 0 || i >= g_towerCount || g_tower[i].state != 0) return;
  g_tower[i].state = 1;
  b3RevoluteJoint_SetMotorSpeed(g_tower[i].hinge, 2.5f); // swing toward the flat (upper) limit
}

// open a breach in standing walls at a world point (siege-tower assault, exposed do_breach)
EMSCRIPTEN_KEEPALIVE
void arena_breach(float x, float y, float z, float r) { do_breach(x, y, z, r); }

// Battering ram: a very heavy sled that the crew drives into the gate; wall bricks
// it slams into are breached (handled in the contact drain).
EMSCRIPTEN_KEEPALIVE
int arena_add_ram(float x, float z) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ x, 0.8f, z };
  bd.motionLocks.angularX = true;
  bd.motionLocks.angularY = true;
  bd.motionLocks.angularZ = true;
  bd.linearDamping = 0.5f;
  bd.userData = (void*)(intptr_t) g_count;
  b3BodyId id = b3CreateBody(g_world, &bd);
  b3BoxHull hull = b3MakeBoxHull(0.8f, 0.7f, 2.6f);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = 25.0f;
  sd.baseMaterial.friction = 0.3f;
  sd.filter.categoryBits = CAT_BOULDER; // heavy siege class: hits soldiers, bricks, statics
  sd.filter.maskBits = CAT_STATIC | CAT_SOLDIER | CAT_BRICK | CAT_BOULDER;
  sd.enableContactEvents = true;
  b3CreateHullShape(id, &sd, &hull.base);
  return push_body_ext(id, KIND_RAM, 0.8f, 0.7f, 2.6f);
}

// Drive any dynamic body horizontally (the ram crew pushing); vertical is preserved.
EMSCRIPTEN_KEEPALIVE
void arena_set_velocity(int h, float vx, float vz) {
  if (h < 0 || h >= g_count || g_kind[h] == KIND_DEAD) return;
  b3Vec3 v = b3Body_GetLinearVelocity(g_bodies[h]);
  b3Body_SetLinearVelocity(g_bodies[h], (b3Vec3){ vx, v.y, vz });
}

// Radial-impulse explosion (fire pots): physically blasts soldiers, rubble, and
// corpses outward. Gameplay damage is applied by JS; this is the physics kick.
EMSCRIPTEN_KEEPALIVE
void arena_explode(float x, float y, float z, float radius, float impulsePerArea) {
  b3ExplosionDef ed = b3DefaultExplosionDef();
  ed.position = (b3Pos){ x, y, z };
  ed.radius = radius;
  ed.falloff = radius * 0.6f;
  ed.impulsePerArea = impulsePerArea;
  ed.maskBits = CAT_SOLDIER | CAT_BRICK | CAT_BOULDER | CAT_RAGDOLL;
  b3World_Explode(g_world, &ed);
}

// Impulse on one body (cavalry charge impact knocking a soldier flying).
EMSCRIPTEN_KEEPALIVE
void arena_impulse(int h, float ix, float iy, float iz) {
  if (h < 0 || h >= g_count || g_kind[h] == KIND_DEAD) return;
  b3Body_ApplyLinearImpulseToCenter(g_bodies[h], (b3Vec3){ ix, iy, iz }, true);
}

// Closest-hit ray cast; returns the hit body's handle, or -1 on miss. Used for
// arrow impacts (a vertical ray at the landing column picks the soldier hit, and
// real geometry — walls — occludes it).
EMSCRIPTEN_KEEPALIVE
int arena_raycast(float x0, float y0, float z0, float x1, float y1, float z1) {
  b3Pos origin = { x0, y0, z0 };
  b3Vec3 translation = { x1 - x0, y1 - y0, z1 - z0 };
  b3RayResult r = b3World_CastRayClosest(g_world, origin, translation, b3DefaultQueryFilter());
  if (!r.hit) return -1;
  return (int)(intptr_t) b3Body_GetUserData(b3Shape_GetBody(r.shapeId));
}

// ---- destructible masonry (ported from box3d samples sample_siege/sample_city) ----

// Fort bricks spawn STATIC so a crowd of soldiers can't shove a wall over — only
// a boulder impact converts nearby bricks to dynamic (see do_breach), so walls
// stand until bombarded, then cave in.
static int make_brick(float x, float y, float z, float hx, float hy, float hz, float yaw) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_staticBody;
  bd.position = (b3Pos){ x, y, z };
  bd.rotation = b3MakeQuatFromAxisAngle((b3Vec3){ 0.0f, 1.0f, 0.0f }, yaw);
  bd.userData = (void*)(intptr_t) g_count;
  b3BodyId id = b3CreateBody(g_world, &bd);
  b3BoxHull hull = b3MakeBoxHull(hx, hy, hz);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = 4.0f;
  sd.baseMaterial.friction = 0.75f;
  sd.filter.categoryBits = CAT_BRICK;
  sd.filter.maskBits = MASK_ALL;
  b3CreateHullShape(id, &sd, &hull.base);
  return push_body_ext(id, KIND_BRICK, hx, hy, hz);
}

// Straight running-bond wall from (x0,z0) to (x1,z1). Bricks are sized to the span
// minus a 0.06 gap so nothing spawns interpenetrating (sample's key stability trick).
static void build_wall(float x0, float z0, float x1, float z1, int courses, float thick) {
  float dx = x1 - x0, dz = z1 - z0, len = sqrtf(dx * dx + dz * dz);
  if (len < 1e-3f) return;
  float ux = dx / len, uz = dz / len, yaw = atan2f(-uz, ux);
  int n = (int)(len / 2.0f); if (n < 1) n = 1;
  float spacing = len / n, hx = 0.5f * spacing - 0.06f;
  for (int c = 0; c < courses; c++) {
    float y = 0.5f + c * 1.0f;
    int odd = c & 1, cn = odd ? n - 1 : n;      // offset course: one fewer brick
    if (cn < 1) cn = n;
    for (int i = 0; i < cn; i++) {
      float t = odd ? (i + 1) * spacing : (i + 0.5f) * spacing; // half-brick stagger
      make_brick(x0 + ux * t, y, z0 + uz * t, hx, 0.5f, thick, yaw);
    }
  }
}

// Round tower/keep: straight-chord bricks around a circle, alternating courses
// staggered by half a segment. Chord (not arc) half-width avoids overlap.
static void build_tower(float cx, float cz, float radius, int sides, int courses) {
  float chord = radius * sinf(PI_F / sides) - 0.06f;
  if (chord < 0.05f) chord = 0.05f;
  for (int c = 0; c < courses; c++) {
    float y = 0.5f + c * 1.0f, rot0 = (c & 1) ? PI_F / sides : 0.0f;
    for (int k = 0; k < sides; k++) {
      float th = rot0 + (k + 0.5f) * (2.0f * PI_F / sides);
      make_brick(cx + cosf(th) * radius, y, cz + sinf(th) * radius, chord, 0.5f, 0.7f, th + 0.5f * PI_F);
    }
  }
}

// Exported wall/round-building primitives so JS can compose whole medieval city
// layouts (grid districts, radial onion rings) without new C per layout.
EMSCRIPTEN_KEEPALIVE
int arena_build_wall(float x0, float z0, float x1, float z1, int courses, float thick) {
  int before = g_count;
  build_wall(x0, z0, x1, z1, courses, thick);
  return g_count - before;
}

// Round building/keep/curtain. gateYaw (atan2(dz,dx) convention) opens a doorway
// facing that direction when hasGate != 0; -makes onion curtains enterable.
EMSCRIPTEN_KEEPALIVE
int arena_build_rondel(float cx, float cz, float radius, int sides, int courses, float gateYaw, int hasGate) {
  int before = g_count;
  float chord = radius * sinf(PI_F / sides) - 0.06f;
  if (chord < 0.05f) chord = 0.05f;
  const float gateHalf = (PI_F / sides) * 1.7f; // skip ~2 segments per course at the gate
  for (int c = 0; c < courses; c++) {
    float y = 0.5f + c * 1.0f, rot0 = (c & 1) ? PI_F / sides : 0.0f;
    for (int k = 0; k < sides; k++) {
      float th = rot0 + (k + 0.5f) * (2.0f * PI_F / sides);
      if (hasGate) {
        float dth = th - gateYaw;
        while (dth > PI_F) dth -= 2.0f * PI_F;
        while (dth < -PI_F) dth += 2.0f * PI_F;
        if (dth > -gateHalf && dth < gateHalf) continue;
      }
      make_brick(cx + cosf(th) * radius, y, cz + sinf(th) * radius, chord, 0.5f, 0.7f, th + 0.5f * PI_F);
    }
  }
  return g_count - before;
}

// A square castle centered at (cx,cz): curtain walls with a gate gap, four corner
// towers, and a central keep. gateDir picks which z-side holds the gate (-1 = -z,
// +1 = +z) so each team's fort can open toward the enemy. Returns the brick count.
EMSCRIPTEN_KEEPALIVE
int arena_build_fort(float cx, float cz, float S, int courses, int gateDir) {
  int before = g_count;
  const float gate = 6.0f, tr = 2.2f, in = 2.6f; // inset walls so corner towers fill the gaps
  const float gz = cz + gateDir * S, bz = cz - gateDir * S; // gated wall / solid back wall
  build_wall(cx - S + in, gz, cx - gate * 0.5f, gz, courses, 1.0f); // gate wall, left of gap
  build_wall(cx + gate * 0.5f, gz, cx + S - in, gz, courses, 1.0f); // gate wall, right of gap
  build_wall(cx - S + in, bz, cx + S - in, bz, courses, 1.0f);      // solid rear wall
  build_wall(cx - S, cz - S + in, cx - S, cz + S - in, courses, 1.0f); // left
  build_wall(cx + S, cz - S + in, cx + S, cz + S - in, courses, 1.0f); // right
  build_tower(cx - S, cz - S, tr, 9, courses + 2);
  build_tower(cx + S, cz - S, tr, 9, courses + 2);
  build_tower(cx - S, cz + S, tr, 9, courses + 2);
  build_tower(cx + S, cz + S, tr, 9, courses + 2);
  build_tower(cx, cz, 3.0f, 12, courses + 3);
  return g_count - before;
}
