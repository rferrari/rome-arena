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

// ---- soldier capsule dimensions (upright, planar battle) ----
#define SOL_RADIUS 0.35f
#define SOL_LOW    0.40f
#define SOL_HIGH   1.05f
#define SOL_DENSITY 1.0f

// body kinds (also written into the transform buffer's flags slot)
enum { KIND_DEAD = 0, KIND_SOLDIER = 1, KIND_BRICK = 2, KIND_BOULDER = 3, KIND_STATIC = 4, KIND_RAGDOLL = 5 };

// collision categories. Ragdolls (dead soldiers) collide only with the world/rubble
// so corpses fall realistically without blocking the living battle.
#define CAT_STATIC  0x1u
#define CAT_SOLDIER 0x2u
#define CAT_BOULDER 0x4u
#define CAT_BRICK   0x8u
#define CAT_RAGDOLL 0x10u
#define MASK_ALL    0xFFFFFFFFu
#define PI_F 3.14159265358979323846f

// floats per body in the transform buffer: x,y,z, qx,qy,qz,qw, flags
#define XF_STRIDE 8

static b3WorldId g_world;
static b3BodyId* g_bodies = NULL;
static unsigned char* g_kind = NULL;
static float* g_xf = NULL;      // transform out buffer  (XF_STRIDE * cap)
static float* g_intent = NULL;  // soldier intent buffer (2 * cap): desired vx,vz
static int g_cap = 0;
static int g_count = 0;

// contact begin-touch pairs drained each step (handleA, handleB), for JS damage
#define MAX_CONTACTS 8192
static int* g_contacts = NULL;
static int g_contactCount = 0;

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

  free(g_bodies); free(g_kind); free(g_xf); free(g_intent); free(g_contacts);
  g_cap = maxBodies;
  g_count = 0;
  g_contactCount = 0;
  g_bodies = (b3BodyId*) malloc(sizeof(b3BodyId) * g_cap);
  g_kind = (unsigned char*) calloc(g_cap, 1);
  g_xf = (float*) calloc(g_cap * XF_STRIDE, sizeof(float));
  g_intent = (float*) calloc(g_cap * 2, sizeof(float));
  g_contacts = (int*) calloc(MAX_CONTACTS * 2, sizeof(int));
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
EMSCRIPTEN_KEEPALIVE
int arena_add_soldier(float x, float z) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Pos){ x, 0.0f, z };
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
  return push_body(id, KIND_SOLDIER);
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

  // drain begin-touch contacts into the shared int buffer as (handleA, handleB)
  b3ContactEvents ce = b3World_GetContactEvents(g_world);
  g_contactCount = 0;
  for (int i = 0; i < ce.beginCount && g_contactCount < MAX_CONTACTS; i++) {
    int ha = (int)(intptr_t) b3Body_GetUserData(b3Shape_GetBody(ce.beginEvents[i].shapeIdA));
    int hb = (int)(intptr_t) b3Body_GetUserData(b3Shape_GetBody(ce.beginEvents[i].shapeIdB));
    g_contacts[g_contactCount * 2] = ha;
    g_contacts[g_contactCount * 2 + 1] = hb;
    g_contactCount++;
  }

  for (int h = 0; h < g_count; h++) {
    float* o = g_xf + h * XF_STRIDE;
    if (g_kind[h] == KIND_DEAD) { o[7] = KIND_DEAD; continue; }
    b3WorldTransform t = b3Body_GetTransform(g_bodies[h]);
    o[0] = (float) t.p.x; o[1] = (float) t.p.y; o[2] = (float) t.p.z;
    o[3] = t.q.v.x; o[4] = t.q.v.y; o[5] = t.q.v.z; o[6] = t.q.s;
    o[7] = (float) g_kind[h];
  }
}

// Contacts drained during the last arena_step: a flat (handleA, handleB) int
// buffer of length 2*arena_contact_count(). JS maps handles -> game objects.
EMSCRIPTEN_KEEPALIVE int arena_contact_count(void) { return g_contactCount; }
EMSCRIPTEN_KEEPALIVE int* arena_contacts_ptr(void) { return g_contacts; }

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

// Turn a soldier's capsule into a toppling corpse: unlock rotation, refilter so it
// only collides with the world/rubble (never the living), and fling it. Reuses the
// existing body, so no new bodies and no ragdoll body-budget growth.
EMSCRIPTEN_KEEPALIVE
void arena_ragdoll(int h, float vx, float vy, float vz, float spin) {
  if (h < 0 || h >= g_count || g_kind[h] == KIND_DEAD) return;
  b3BodyId id = g_bodies[h];
  b3MotionLocks freeLocks = { 0 };
  b3Body_SetMotionLocks(id, freeLocks);
  b3ShapeId sh;
  if (b3Body_GetShapes(id, &sh, 1) == 1) {
    b3Filter f = { CAT_RAGDOLL, CAT_STATIC | CAT_BRICK, 0 };
    b3Shape_SetFilter(sh, f, true);
  }
  b3Body_SetAwake(id, true);
  b3Body_SetLinearVelocity(id, (b3Vec3){ vx, vy, vz });
  b3Body_SetAngularVelocity(id, (b3Vec3){ vz * spin, spin, -vx * spin });
  g_kind[h] = KIND_RAGDOLL;
}

// ---- destructible masonry (ported from box3d samples sample_siege/sample_city) ----

static int make_brick(float x, float y, float z, float hx, float hy, float hz, float yaw) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
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
  return push_body(id, KIND_BRICK);
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

// A square castle centered at (cx,cz): curtain walls (gate gap in the front, -z
// side), four corner towers, and a central keep. Returns the brick count.
EMSCRIPTEN_KEEPALIVE
int arena_build_fort(float cx, float cz, float S, int courses) {
  int before = g_count;
  const float gate = 6.0f, tr = 2.2f, in = 2.6f; // inset walls so corner towers fill the gaps
  build_wall(cx - S + in, cz - S, cx - gate * 0.5f, cz - S, courses, 1.0f); // front-left
  build_wall(cx + gate * 0.5f, cz - S, cx + S - in, cz - S, courses, 1.0f); // front-right
  build_wall(cx - S + in, cz + S, cx + S - in, cz + S, courses, 1.0f);      // back
  build_wall(cx - S, cz - S + in, cx - S, cz + S - in, courses, 1.0f);      // left
  build_wall(cx + S, cz - S + in, cx + S, cz + S - in, courses, 1.0f);      // right
  build_tower(cx - S, cz - S, tr, 9, courses + 2);
  build_tower(cx + S, cz - S, tr, 9, courses + 2);
  build_tower(cx - S, cz + S, tr, 9, courses + 2);
  build_tower(cx + S, cz + S, tr, 9, courses + 2);
  build_tower(cx, cz, 3.0f, 12, courses + 3);
  return g_count - before;
}
