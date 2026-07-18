PORT ?= 8321
T0 ?= 2
T1 ?= 2
SEED ?= 42

start: ## run the multiplayer battle server (http + websocket)
	bun server.js --port $(PORT) --t0 $(T0) --t1 $(T1) --seed $(SEED)

test: ## headless sim smoke test — asserts combat mechanics fire
	bun test_sim.js

wasm: ## (maintainer) build the box3d physics module -> physics/arena.{mjs,wasm}; needs emscripten
	bash physics/build.sh

wasm-test: ## headless physics smoke test (drop a cube, assert it settles)
	bun physics/smoke.js

help:
	@grep -E '^[a-z]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/ —/'

.PHONY: start test help
