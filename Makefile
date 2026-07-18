PORT ?= 8321
T0 ?= 2
T1 ?= 2
SEED ?= 42
FORT ?= 0

start: ## run the multiplayer battle server (http + websocket); FORT=1 adds a central castle
	bun server.js --port $(PORT) --t0 $(T0) --t1 $(T1) --seed $(SEED) --fort $(FORT)

# default matchup: Meta Llama 70B (Red) vs OpenAI GPT-OSS 120B (Blue), both on Groq.
# override e.g. AI0=mock, or AI1=groq:qwen/qwen3.6-27b, or AI0=openai / pioneer.
AI0 ?= groq:llama-3.3-70b-versatile
AI1 ?= groq:openai/gpt-oss-120b
AITURN ?= 4
ai: ## LLM generals battle: AI0/AI1 = provider[:model] (groq|openai|pioneer|mock); needs *_API_KEY; auto-starts
	bun server.js --port $(PORT) --t0 $(T0) --t1 $(T1) --fort $(FORT) --ai0 $(AI0) --ai1 $(AI1) --aiturn $(AITURN) --autostart 1

test: ## headless sim smoke test — asserts combat mechanics fire
	bun test_sim.js

wasm: ## (maintainer) build the box3d physics module -> physics/arena.{mjs,wasm}; needs emscripten
	bash physics/build.sh

wasm-test: ## headless physics smoke test (drop a cube, assert it settles)
	bun physics/smoke.js

wasm-bench: ## physics body-count perf gate (500 soldiers + 1000 bricks + 20 boulders)
	bun physics/bench.js

wasm-fort: ## build a castle and bombard it; assert masonry is stable then caves in
	bun physics/fort.js

help:
	@grep -E '^[a-z]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/ —/'

.PHONY: start ai test wasm wasm-test wasm-bench wasm-fort help
