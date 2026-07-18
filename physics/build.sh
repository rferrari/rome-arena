#!/usr/bin/env bash
# Build the box3d physics WASM module -> physics/arena.mjs + physics/arena.wasm.
# Requires emscripten (emcc/emcmake on PATH; `source path/to/emsdk_env.sh`).
# This is a MAINTAINER step: the built artifacts are committed, so players/CI run
# `make start` / `make test` with zero toolchain (like the CDN three.js).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BOX3D_DIR="${BOX3D_DIR:-/home/adam/box3d-demo/box3d}"
BUILD="$HERE/build"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "error: emscripten not found (emcmake missing)." >&2
  echo "  Install emsdk, then: source /path/to/emsdk/emsdk_env.sh" >&2
  exit 1
fi
if [ ! -d "$BOX3D_DIR" ]; then
  echo "error: box3d sources not found at BOX3D_DIR=$BOX3D_DIR" >&2
  exit 1
fi

emcmake cmake -S "$HERE" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DBOX3D_DIR="$BOX3D_DIR"
cmake --build "$BUILD" -j"$(nproc)"

cp "$BUILD/arena.mjs" "$HERE/arena.mjs"
cp "$BUILD/arena.wasm" "$HERE/arena.wasm"
echo "OK: built physics/arena.mjs + physics/arena.wasm"
