# Rome Arena

A browser battle simulator with **real physics**: two armies of instanced humanoid
soldiers clash on a 200×140 field, catapults and trebuchets fling boulders that bowl
through the ranks and cave in castle walls, the dead ragdoll where they fall. The
physics is [box3d](https://github.com/erincatto/box3d) (Erin Catto's 3D rigid-body
engine, MIT) compiled to WebAssembly; everything else is Bun + three.js with **no
bundler and no install step**.

This `all-modes` branch is the single unified build — every mode and feature below is
here, selected by flags. No branch-switching.

```bash
make start FORT=1 TIER=high     # open the browser at http://localhost:8321 and press FIGHT
```

---

## Quick start

```bash
make start                     # plain open-field battle (4v4)
make start FORT=1              # + medieval-city siege
make start FORT=1 DOM=1        # + domination scoring
make dom FORT=1               # shortcut: domination siege
make ctf                       # capture-the-flag (small squads)
make ai FORT=1                 # two LLM generals fight a siege (needs an API key)
make stress                    # ultra tier + forts, everything cranked
```

No build needed to play — the compiled `physics/arena.wasm` is committed. You only
need emscripten if you change the C physics (`make wasm`).

## Modes & options

Flags combine freely. Set them on any `make` target (they're plain Make variables).

| Flag | Values | What it does |
|------|--------|--------------|
| `TIER` | `low` \| `mid` \| `high` \| `ultra` | Scales the whole scene at once — army size, ragdolls, castle detail, render quality. `low` is already a full 4v4; each step multiplies unit sizes (`ultra` ≈ 2× → ~5k soldiers). |
| `FORT` | `0` \| `1` | Spawns the destructible **medieval cities** (see below) + siege engines + wall garrisons. |
| `DOM` | `0` \| `1` | **Domination**: three capture zones (one at each home castle, one at midfield). Holding a zone bleeds the enemy's tickets; first to 0 loses. |
| `CTF` | `0` \| `1` | **Capture the flag**: small squads race to steal the enemy banner and carry it home. |
| `TIER`/`FORT`/`DOM`/`CTF` | — | can all be set together, e.g. `make start FORT=1 DOM=1 TIER=high`. |
| `SEED` | integer | Battle RNG seed (reproducible). |
| `PORT` | integer | Server port (default 8321). |

### `make ai` — LLM generals

Two language models command the armies (one per side), issuing orders each turn.

```bash
make ai                             # default: Llama-3.3-70B (Red) vs GPT-OSS-120B (Blue) on Groq
make ai FORT=1 DOM=1                # generals fight a domination siege
make ai AI0=mock AI1=mock          # no API key — scripted "mock" generals
make ai AI1=groq:openai/gpt-oss-20b AITURN=12   # smaller model, slower turns (rate limits)
```

| Flag | Meaning |
|------|---------|
| `AI0`, `AI1` | `provider[:model]` per team. Providers: `groq`, `openai`, `pioneer`, `mock`, `none`. |
| `AITURN` | Seconds between a general's orders (raise it if you hit Groq's TPM rate limit). |

**API keys** go in a `.env` file (gitignored, never committed):

```
GROQ_API_KEY=...
OPENAI_API_KEY=...
```

Every AI battle is **recorded** to `replays/*.json` (also gitignored). Review one with
the in-browser viewer — play/pause/step, scrub, and see each general's decisions in
sync:

```
http://localhost:8321/?replay=/replays/<file>.json      # or browse /replays for the list
```

## What's in a siege (`FORT=1`)

- **Two asymmetric medieval cities.** Red is a **grid** city (square king castle +
  square-house districts on straight streets); Blue is a **radial onion** (round keep
  inside a gated circular curtain wall, ringed by round houses). Two forward
  watchtowers each, set just ahead of the deployment line so the flanks stay open.
- **Battlement garrisons** — archers stand on the *real* wall bricks and rain arrows;
  breach the wall and the garrison tumbles down with the rubble.
- **Jointed siege engines** (the box3d showcase):
  - **Trebuchets** — a throwing arm on a revolute joint, whipped by the joint motor;
    the boulder releases from the moving arm tip mid-swing. Longer-ranged than catapults.
  - **Battering rams** — heavy sleds the crew drives into the gate, breaching the
    masonry they slam into.
- **Carnage** — fire pots detonate on impact (a real radial-impulse explosion that
  blasts soldiers, corpses, and rubble outward), falling masonry crushes soldiers, and
  explosions / cavalry charges knock survivors sprawling before they get back up.

## Playing (browser)

- **LMB drag** select units · **RMB drag** set a facing line · **RMB click** move
- **T** toggle stance (testudo / phalanx) · **`[` `]`** widen/narrow files
- **WASD** pan · **mouse wheel** zoom

If no server is running, the page falls back to a **solo** match against the built-in
AI using the exact same simulation. Add `#fort`, `#dom`, or `#ctf` to the URL to pick a
solo mode.

## Development

```bash
make test        # headless sim regression — asserts every combat mechanic fires
make wasm        # rebuild the box3d physics module (needs emscripten at ~/emsdk)
make wasm-test   # physics smoke test (drop a cube, assert it settles)
make wasm-fort   # build a castle, bombard it, assert it caves in
make help        # list every target
```

### Architecture

Server-authoritative: the sim runs on the server (or locally for solo), clients only
send orders and render snapshots — so there's no lockstep-desync class of bugs.

| File | Role |
|------|------|
| `sim.js` | Pure simulation (no three.js/DOM): AI, morale, orders, combat, deployment, forts/zones/flags. Runs on both Bun and in the browser. |
| `physics/arena_physics.c` | C glue over box3d — soldiers, bricks, boulders, ragdolls, siege engines, explosions. Compiled to `arena.wasm`. |
| `physics/arena_api.js` | Typed JS wrapper over the WASM batch API (shared-HEAP buffers, one `step` per tick). |
| `physics/config.js` | Central scaling knobs + the `low/mid/high/ultra` tier table. |
| `physics/flowfield.js` | BFS flow-field pathfinding so armies route around walls and through breaches. |
| `server.js` | Bun server: lobby, authoritative sim loop, binary snapshots @12Hz, replay recording. |
| `battle.js` | three.js renderer + input + WebSocket client (instanced humanoids, ragdolls, masonry, siege engines, HUDs). |
| `ai/` | LLM commander: OpenAI-compatible provider adapters + the order-issuing prompt loop. |

The physics is a **single-threaded, scalar** WASM build (no pthreads → no
SharedArrayBuffer → no special COOP/COEP headers needed), which is why it just loads
over plain HTTP.
