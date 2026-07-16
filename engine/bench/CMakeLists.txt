# engine/bench/CMakeLists.txt
#
# Standalone bench executable for the Doc02 layered compositor POC. Does not
# link CEF; only the scalar mixer + compositor + protocol parser sources.
#
# Build:
#   cd engine/bench && mkdir build && cd build
#   cmake -DCMAKE_BUILD_TYPE=Release ..
#   cmake --build .
#   ./layered_compositor_bench [<graph-path> [<iters> [<w> [<h>]]]]

cmake_minimum_required(VERSION 3.21)
project(bg_layered_compositor_bench LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(layered_compositor_bench
  layered_compositor_bench.cpp
  ../src/compositor/synthetic_snapshot.cpp
  ../src/compositor/layered_compositor.cpp
  ../src/mixer/cpu_layer_mixer.cpp
  ../src/mixer/simd_blend.cpp
  ../src/mixer/affine_sampler.cpp
  ../src/mixer/mask_ops.cpp
  ../src/mixer/mixer_buffer_pool.cpp
  ../src/mixer/fallback_reason.cpp
  ../src/mixer/graph_message_parser.cpp
  ../src/mixer/render_graph_store.cpp
)

target_include_directories(layered_compositor_bench PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../src"
)

target_compile_options(layered_compositor_bench PRIVATE
  -Wall -Wextra -Wno-unused-parameter -O3
)
