cmake_minimum_required(VERSION 3.21)

project(p20_decklink_field_capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(DECKLINK_SDK_INCLUDE "" CACHE PATH
    "Path to Blackmagic DeckLink SDK Linux/include")
set(DECKLINK_API_LIBRARY "" CACHE FILEPATH
    "Path to libDeckLinkAPI.so")

if(NOT DECKLINK_SDK_INCLUDE)
  message(FATAL_ERROR
    "Set -DDECKLINK_SDK_INCLUDE='/path/to/Blackmagic DeckLink SDK/Linux/include'")
endif()
if(NOT EXISTS "${DECKLINK_SDK_INCLUDE}/DeckLinkAPI.h")
  message(FATAL_ERROR "DeckLinkAPI.h not found in ${DECKLINK_SDK_INCLUDE}")
endif()

if(NOT DECKLINK_API_LIBRARY)
  find_library(DECKLINK_API_LIBRARY NAMES DeckLinkAPI REQUIRED)
endif()

find_package(Threads REQUIRED)

# SDK 16 ships versioned iterator exports (for example
# CreateDeckLinkIteratorInstance_0004). Its dispatch source resolves that ABI
# from libDeckLinkAPI.so while preserving the header's public factory function.
add_executable(decklink_field_capture
  decklink_field_capture.cpp
  "${DECKLINK_SDK_INCLUDE}/DeckLinkAPIDispatch.cpp"
)
target_include_directories(decklink_field_capture PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${DECKLINK_SDK_INCLUDE}"
)
target_link_libraries(decklink_field_capture PRIVATE
  "${DECKLINK_API_LIBRARY}"
  Threads::Threads
  dl
)
target_compile_options(decklink_field_capture PRIVATE -Wall -Wextra -Wpedantic -Werror)

enable_testing()
add_executable(decklink_field_decode_test decklink_field_decode_test.cpp)
target_include_directories(decklink_field_decode_test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(decklink_field_decode_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_test(NAME decklink_field_decode_unit COMMAND decklink_field_decode_test)
