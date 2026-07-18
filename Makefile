PORT ?= 8321
SEED ?= 42
FORT ?= 0
TIER ?= mid

# TIER (low|mid|high|ultra) scales army size, ragdolls, castle detail + render quality.
# Force the NVIDIA GPU in the BROWSER you open (Linux/Optimus) e.g.:
#   __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia google-chrome http://localhost:8321
start: ## run the battle server; TIER=low|mid|high|ultra, FORT=1 adds castles
	bun server.js --port $(PORT) --tier $(TIER) --seed $(SEED) --fort $(FORT)

stress: ## max-scale stress test: ultra tier + castles
	bun server.js --port $(PORT) --tier ultra --seed $(SEED) --fort 1

# default matchup: Meta Llama 70B (Red) vs OpenAI GPT-OSS 120B (Blue), both on Groq.
# override e.g. AI0=mock, or AI1=groq:qwen/qwen3.6-27b, or AI0=openai / pioneer.
# NOTE: Groq free tier is token-per-minute limited (gpt-oss-120b ~8000 TPM). If you
# see HTTP 429, raise AITURN (slower turns) or use a smaller model, e.g.
#   make ai AITURN=12   /   make ai AI1=groq:openai/gpt-oss-20b
AI0 ?= groq:llama-3.3-70b-versatile
AI1 ?= groq:openai/gpt-oss-120b
AITURN ?= 10
ai: ## LLM generals battle: AI0/AI1 = provider[:model] (groq|openai|pioneer|mock); needs *_API_KEY; auto-starts
	bun server.js --port $(PORT) --tier $(TIER) --fort $(FORT) --ai0 $(AI0) --ai1 $(AI1) --aiturn $(AITURN) --autostart 1

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

.PHONY: start stress ai test wasm wasm-test wasm-bench wasm-fort help
