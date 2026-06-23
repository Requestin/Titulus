# engine/CMakeLists.txt — bg_engine build (DEVELOPMENT_PROMPT §9.1)
#
# C++20 + CEF OSR render host. CPU-only. Reimplemented by reference from
# CasparCG (see CASPARRCG_PORTING.md); no CasparCG code is linked or shipped.
#
# CEF is expected to be present under engine/third_party/cef/ (downloaded by
# third_party/fetch-cef.sh, gitignored). The exact version directory name varies,
# so we glob it.
#
# Build:
#   cd engine && mkdir build && cd build
#   cmake -DCMAKE_BUILD_TYPE=Release ..
#   make -j$(nproc)
#   ./Release/bg_engine --consumer=null --url=http://localhost:3001/channel.html --duration=60

cmake_minimum_required(VERSION 3.21)

project(bg_engine LANGUAGES C CXX)

# C++20, no exceptions/RTTI in hot paths (DEVELOPMENT_PROMPT §16).
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Only Debug/Release (CEF dist expects these configuration types).
set(CMAKE_CONFIGURATION_TYPES Debug Release)

# -----------------------------------------------------------------------------
# Locate the CEF binary distribution.
# -----------------------------------------------------------------------------
# The fetched dist extracts to third_party/cef/cef_binary_<ver>_linux64_minimal/.
# Resolve the directory dynamically so a CEF version bump doesn't require an edit
# here.
file(GLOB _CEF_DIST_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cef/cef_binary_*_linux64_minimal")
list(REMOVE_ITEM _CEF_DIST_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cef/cef_binary_*_linux64_minimal.tar.bz2")
if(NOT _CEF_DIST_DIRS)
  message(FATAL_ERROR
    "CEF distribution not found under engine/third_party/cef/. "
    "Run: engine/third_party/fetch-cef.sh")
endif()
list(GET _CEF_DIST_DIRS 0 CEF_ROOT)
message(STATUS "bg_engine: using CEF at ${CEF_ROOT}")

# CEF's own cmake modules (FindCEF.cmake, cef_variables.cmake, cef_macros.cmake)
# expect CEF_ROOT + CMAKE_MODULE_PATH set before find_package(CEF).
set(CMAKE_MODULE_PATH "${CMAKE_MODULE_PATH};${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)

# Build CEF's static libcef_dll_wrapper (defines target `libcef_dll_wrapper`).
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)

# -----------------------------------------------------------------------------
# bg_engine sources.
# -----------------------------------------------------------------------------
set(BG_SOURCES
  src/main.cpp
  src/engine_app.cpp
  src/engine_client.cpp
  src/config.cpp
  src/stats.cpp
)
set(BG_HEADERS
  src/engine_app.h
  src/engine_client.h
  src/config.h
  src/stats.h
  src/frame_ring.h
  src/message_pump.h
  src/consumers/consumer.h
  src/consumers/null_consumer.h
)

add_executable(bg_engine ${BG_SOURCES} ${BG_HEADERS})

target_include_directories(bg_engine PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CEF_INCLUDE_PATH}"
)

# The DeckLink consumer (Phase 3) compiles conditionally when the Blackmagic
# SDK header is reachable. Until then we ship the null/pipe/preview consumers
# only — no DeckLink linkage.
set(DECKLINK_SDK_INCLUDE "" CACHE PATH
  "Path to 'Blackmagic DeckLink SDK .../Linux/include' (enables decklink consumer)")
option(BG_ENABLE_DECKLINK "Build the DeckLink consumer (requires DeckLink SDK)" OFF)
if(BG_ENABLE_DECKLINK AND DECKLINK_SDK_INCLUDE AND EXISTS "${DECKLINK_SDK_INCLUDE}/DeckLinkAPI.h")
  message(STATUS "bg_engine: DeckLink consumer ENABLED (SDK: ${DECKLINK_SDK_INCLUDE})")
  target_sources(bg_engine PRIVATE
    src/consumers/decklink_consumer.cpp
    src/consumers/decklink_consumer.h)
  target_include_directories(bg_engine PRIVATE "${DECKLINK_SDK_INCLUDE}")
  target_compile_definitions(bg_engine PRIVATE BG_ENABLE_DECKLINK=1)
else()
  message(STATUS "bg_engine: DeckLink consumer disabled (code-complete in Phase 3, needs SDK + HW)")
endif()

target_compile_features(bg_engine PRIVATE cxx_std_20)
target_compile_options(bg_engine PRIVATE
  -Wall -Wextra -Wno-unused-parameter
  # CEF recommends these for the off-screen-rendering / Alloy path.
  -Wno-deprecated-declarations
  # CEF's CefStructBaseSimple zero-init triggers -Wmissing-field-initializers in
  # its own headers; silence it so our own code warnings stay signal.
  -Wno-missing-field-initializers
)

# Link the CEF wrapper + libcef.so + CEF standard system libs.
# libcef.so is provided as a per-config path (Release/libcef.so) by CEF's
# cef_variables.cmake; the wrapper (libcef_dll_wrapper) provides the C++ shim.
target_link_libraries(bg_engine PRIVATE
  libcef_dll_wrapper
  ${CEF_STANDARD_LIBS}
  $<$<CONFIG:Release>:${CEF_LIB_RELEASE}>
  $<$<CONFIG:Debug>:${CEF_LIB_DEBUG}>
)

# Output the binary next to libcef.so / Resources so the loader finds them at
# runtime (CEF expects libcef.so in the same dir or on the loader path). We use
# the per-config Release/ dir as CEF does.
SET_CEF_TARGET_OUT_DIR()
set_target_properties(bg_engine PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE}"
  BUILD_RPATH "$ORIGIN"
)

# Copy CEF runtime binaries (libcef.so etc.) and resources (locales, .pak)
# next to bg_engine so it runs out-of-the-box.
COPY_FILES(bg_engine "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE}")
COPY_FILES(bg_engine "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE}")
# Linux CEF dist ships a chrome-sandbox helper needing setuid; set it up.
SET_LINUX_SUID_PERMISSIONS(bg_engine "${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE}/chrome-sandbox")
