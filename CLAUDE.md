# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime & commands

Runs on **Bun** (not Node). No `package.json`, no dependency install — `three` and
`@pixiv/three-vrm` load in the browser via an importmap CDN, so there is nothing to
`npm install` to run the game.

```bash
make start                       # multiplayer server on :8321 (2v2, seed 42)
make start FORT=1                # ...with a central destructible castle
make start PORT=9000 T0=1 T1=3   # override port / team sizes
make test                        # headless battle sim (asserts combat mechanics fire)
make wasm                        # (maintainer) rebuild the box3d physics WASM — needs emscripten
make wasm-test / wasm-bench / wasm-fort   # physics: smoke / perf gate / masonry destruction
```

Physics runs in a **box3d WASM module** (`physics/arena.wasm` + `arena.mjs`).
Those artifacts are **committed**, so `make start`/`make test` stay zero-install;
only `make wasm` needs the emscripten toolchain (`source ~/emsdk/emsdk_env.sh`).
The module is built as a scalar (non-SIMD), single-threaded build — see
`physics/build.sh` / `CMakeLists.txt` for why (WASM-SIMD crashed clang; single
thread avoids SharedArrayBuffer/COOP-COEP).

There is no test framework. `test_sim.js` runs an all-AI battle headless and
`process.exit(1)`s if any asserted mechanic (arrows, boulders, anti-cav, charge,
shield-wall blocks, routs) fails, or if a step exceeds the 30Hz budget (33ms).
`physics/*.js` are standalone `bun` checks for the physics layer. Add assertions
to whichever matches when changing mechanics or the physics glue.

## Two independent apps in one repo

1. **Battle sim** (the main app) — `battle.html` → `battle.js` + `sim.js` + `server.js`.
   A field battle: massed formations of soldiers, server-authoritative multiplayer.
2. **Mapgen demo** — `index.html` + `mapgen/arena.js` + `mapgen/mobs.js`.
   A standalone three.js demo that procedurally generates a Colosseum arena and
   scatters GLB mobs at spawn points. It is **not wired into the battle sim** — it's
   a separate asset/handoff surface. `server.js` serves `/` as `battle.html`, so
   the mapgen demo is only reachable by opening `index.html` directly.

## Architecture: the battle sim

The key design decision is **server-authoritative simulation with a shared sim
module**. `sim.js` is pure logic — no three.js, no DOM — so the exact same code runs:
- on the server (`server.js`) as the authority, and
- in the browser (`battle.js`) as a *solo fallback* when no server responds.

Clients never simulate in multiplayer; they only send orders and render snapshots.
This eliminates the whole lockstep-desync bug class.

### Physics: box3d via WASM (`physics/`)
`sim.js` owns *game logic* (AI, morale, combat, orders, stats); **box3d owns all
physics** — soldier movement, crowd collision, projectiles, destructible masonry,
ragdolls. The C glue (`physics/arena_physics.c`) compiles to WASM and is wrapped by
`physics/arena_api.js` (`createArena`). Server and browser each create one arena and
pass it to `createSim({ arena })`.

The JS↔WASM boundary is **batched**: each tick JS writes soldier velocity *intents*
into a shared HEAP buffer, calls `arena.step(dt)` once (apply intents → step world →
write transforms), then reads every body's transform back from a second HEAP buffer
(`arena.transforms`, stride `XF_STRIDE`) — zero per-body crossings. Bodies are
addressed by integer handles; `sim.js` stores each soldier's handle on `s.h`.
Boulders damage via drained contact events; arrows hit via `arena.raycast`; corpses
become ragdolls in-place (`arena.ragdoll`, refiltered so they don't block the living).
Tunables live in `physics/config.js`. Because the sim is server-authoritative, only
per-process reproducibility matters, so the fast non-deterministic box3d build is fine.

### sim.js (the model)
`createSim({ seed, players: [t0, t1] })` returns a sim object. Deterministic:
seeded `mulberry32` PRNG (duplicated inline rather than imported from `arena.js`,
to avoid dragging three.js into the server).

- **Units** are formations; **soldiers** are individuals belonging to a unit.
  Both live in flat arrays (`sim.units`, `sim.soldiers`).
- Unit types and all combat tuning are in the `TYPES` table at the top of `sim.js`
  — hp/dmg/range/speed/cooldown, plus special modifiers: `vsCav` (anti-cavalry),
  `charge` (cavalry impact), `ranged` (archers), and `alt` (a toggleable stance:
  legion→testudo, pike→phalanx, with per-stance spacing/speed/damage multipliers).
- Deployment is fixed per player slot: `COMP_FRONT` (4 melee) up front,
  `COMP_BACK` (archer, cavalry) behind, one catapult in the rear.
- `step(dt)` is the whole tick: spatial-grid rebuild (`CELL`-sized buckets for
  neighbor queries) → per-soldier decide desired velocity + melee → `arena.step`
  (physics integrates movement/collision) → read positions back → morale
  (regen/break at <20/rally at ≥60/flee off-field) → catapults & boulders & arrows
  → **built-in AI** for any slot in `sim.ai` → winner check.
- `sim.ai` is a `Set` of `"team:slot"` keys. A slot in the set is AI-driven; the
  server deletes the key when a human claims the slot and re-adds it on disconnect.
- Order API (caller must validate ownership first): `order(unitIds, p0, p1)` — a
  drag from p0→p1 becomes a facing line and splits units across it; a click (short
  drag) forms them up facing the enemy. `toggleStance`, `adjustFiles`.
- `sim.stats` accumulates counters that `test_sim.js` asserts against.
  `sim.drainEvents()` returns and clears queued visual events (`boom`/`shot`/
  `arrow`/`note`/`over`).

### server.js (authority + transport)
Bun `Bun.serve` doing both static file serving and WebSocket. Game states: `lobby`
→ `playing`. Any player pressing FIGHT starts; after a winner, FIGHT resets to a
fresh lobby (`resetSim`). Runs the sim at **30Hz** (only while playing) and
broadcasts at **12Hz** (always, so the lobby shows the idle armies).

**Binary snapshot protocol** (`snapshot()`): a single `ArrayBuffer` tagged with a
leading `0x01` byte, then `u32` tick, then packed per-soldier records (i16 x/z
×100, u8 facing, u8 flags) and per-unit records. Positions are quantized to
centimeters. JSON is used only for `init`/`lobby`/`ev`/`stats` and inbound orders.
If you change the packed layout, update **both** `snapshot()` in `server.js` and
`decodeSnapshot()` in `battle.js` — they are hand-matched.

### battle.js (client)
Renderer + input + net client. Picks `mode` `'net'` or `'solo'` at boot (`connect()`
falls back to `startSolo()` on WS failure). Reads sim state through `readSoldier`/
`readUnit` adapters that are swapped per mode (`setupNetReaders` decodes snapshots
with ~150ms interpolation delay; `setupSoloReaders` reads the local sim directly),
so the rest of the render loop is mode-agnostic.

**Controls:** WASD/arrows pan, wheel zooms, left-drag marquee-selects your units,
right-click/drag issues an order, `T` toggles stance, `[` / `]` adjust files (rank
width). You can only select/command units on your own `team:slot`.

## Conventions

- Comments tagged `// ponytail:` mark deliberate no-dependency choices (e.g. the
  inlined `mulberry32`). Keep such duplication intentional rather than "fixing" it
  by cross-importing — importing `arena.js` into the server would pull in three.js.
- Field geometry constants (`FIELD_W`, `FIELD_D`, `SPACING`) are exported from
  `sim.js` and reused by the client so both agree on the world size.
- `assets/mobs/manifest.json` catalogs the GLB mobs (beasts + gladiators) used by
  the mapgen demo; they are placeholder art borrowed from another project.
