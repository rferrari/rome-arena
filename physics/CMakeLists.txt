# Wrapper CMake project that builds the arena physics wasm module.
# box3d is pulled in via add_subdirectory so it is NOT the top-level project:
# that skips box3d's EMSCRIPTEN+PROJECT_IS_TOP_LEVEL pthread branch, giving us a
# single-threaded module (no SharedArrayBuffer, no COOP/COEP headers).
# Invoke through physics/build.sh (which wraps this in emcmake).
cmake_minimum_required(VERSION 3.22)
project(arena_physics C)

# BOX3D_DIR points at the vendored engine checkout (sibling repo by default).
if(NOT DEFINED BOX3D_DIR)
  set(BOX3D_DIR "/home/adam/box3d-demo/box3d")
endif()

# Scalar (non-SIMD) build: the wasm SIMD128 path crashes clang's backend at -O3,
# and a scalar build is the documented max-compatibility target. Perf is revisited
# at the Phase 2 body-count gate; re-enable SIMD later if a newer emsdk fixes it.
set(BOX3D_DISABLE_SIMD ON CACHE BOOL "" FORCE)
set(BOX3D_SAMPLES OFF CACHE BOOL "" FORCE)
set(BOX3D_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(BOX3D_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(BOX3D_DOCS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

add_subdirectory(${BOX3D_DIR} box3d-build)

# include box3d's shared/ sample helpers for CreateHuman (jointed ragdolls)
add_executable(arena arena_physics.c ${BOX3D_DIR}/shared/human.c)
target_include_directories(arena PRIVATE ${BOX3D_DIR}/shared)
target_link_libraries(arena PRIVATE box3d)

# Emit arena.mjs (ES6 factory) + arena.wasm, loadable in both Bun and browsers.
set_target_properties(arena PROPERTIES SUFFIX ".mjs")
target_link_options(arena PRIVATE
  "-O3"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sENVIRONMENT=web,worker,node"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPF32','HEAP32','HEAPU8','HEAPU32','cwrap']"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
)
