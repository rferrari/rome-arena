# AI-general battle

Two LLMs act as opposing generals. Every few seconds each commanded team's model
is given a text summary of the battlefield and replies with unit orders (JSON),
which are applied through the sim's normal order API (`sim.order` / `toggleStance`).
Units then execute those orders until the next turn — turn-based command at a low
polling frequency (not per-frame control). Inspired by
[llm_chess_arena](https://github.com/rferrari/llm_chess_arena).

## Run

```bash
make ai AI0=mock AI1=mock          # offline test — no keys needed
make ai AI0=groq AI1=openai        # Groq (Red) vs OpenAI (Blue)
make ai AI0=groq AI1=groq FORT=1   # same-model duel over a castle
# spectate at http://localhost:8321  (battle auto-starts)
```

Flags (also usable via `bun server.js`): `--ai0 <provider> --ai1 <provider>`,
`--aiturn <seconds>` (default 4), `--autostart 1`.

## Providers

All are OpenAI-`/chat/completions`-compatible; keys come from the environment:

| provider | env keys | default model |
|---|---|---|
| `groq`    | `GROQ_API_KEY` (`GROQ_MODEL`, `GROQ_BASE_URL`) | `llama-3.3-70b-versatile` |
| `openai`  | `OPENAI_API_KEY` (`OPENAI_MODEL`, `OPENAI_BASE_URL`) | `gpt-4o-mini` |
| `pioneer` | `PIONEER_API_KEY` (`PIONEER_MODEL`, `PIONEER_BASE_URL`) | `default` |
| `mock`    | none — offline heuristic (all units advance) | — |

Add a provider by extending `PRESETS` in `providers.js`. Pioneer's base URL/model
are assumed OpenAI-compatible; set `PIONEER_BASE_URL`/`PIONEER_MODEL` to match its
API (get a key at https://alpha.pioneers.dev/keys).

## Files
- `providers.js` — provider presets + one OpenAI-compatible `chat()` call.
- `commander.js` — serialize battlefield → prompt → parse orders → apply. `mock` uses a local heuristic.
- server wiring — `server.js` resolves `--ai0/--ai1`, removes the built-in unit AI for commanded teams, and runs the per-team turn loop.
