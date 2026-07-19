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

dom: ## domination: hold 3 zones to bleed enemy tickets (combine with FORT=1)
	bun server.js --port $(PORT) --tier $(TIER) --dom 1 --fort $(FORT) --seed $(SEED)

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

.PHONY: start stress dom test wasm wasm-test wasm-bench wasm-fort help
