# engine/tests/CMakeLists.txt
#
# Standalone test executable for the Doc02 mixer. Built without CEF: it links
# only the scalar mixer sources and GoogleTest-free hand-rolled assertions.
#
# Build:
#   cd engine/tests && mkdir build && cd build
#   cmake -DCMAKE_BUILD_TYPE=Debug ..
#   cmake --build .
#   ctest --output-on-failure

cmake_minimum_required(VERSION 3.21)
project(bg_mixer_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

enable_testing()

add_executable(test_mixer
  test_mixer.cpp
  ../src/mixer/cpu_layer_mixer.cpp
  ../src/mixer/affine_sampler.cpp
  ../src/mixer/mask_ops.cpp
  ../src/mixer/mixer_buffer_pool.cpp
)

target_include_directories(test_mixer PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../src"
)

target_compile_options(test_mixer PRIVATE
  -Wall -Wextra -Wno-unused-parameter
)

add_test(NAME mixer_scalar_goldens COMMAND test_mixer)

add_executable(test_protocol
  test_protocol.cpp
  ../src/mixer/graph_message_parser.cpp
  ../src/mixer/render_graph_store.cpp
)

target_include_directories(test_protocol PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../src"
)

target_compile_options(test_protocol PRIVATE
  -Wall -Wextra -Wno-unused-parameter
)

add_test(NAME protocol_v1_shadow_store COMMAND test_protocol)

add_executable(test_compositor
  test_compositor.cpp
  ../src/compositor/synthetic_snapshot.cpp
  ../src/compositor/layered_compositor.cpp
  ../src/mixer/cpu_layer_mixer.cpp
  ../src/mixer/affine_sampler.cpp
  ../src/mixer/mask_ops.cpp
  ../src/mixer/mixer_buffer_pool.cpp
  ../src/mixer/fallback_reason.cpp
)

target_include_directories(test_compositor PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../src"
)

target_compile_options(test_compositor PRIVATE
  -Wall -Wextra -Wno-unused-parameter
)

add_test(NAME compositor_synthetic_poc COMMAND test_compositor)
