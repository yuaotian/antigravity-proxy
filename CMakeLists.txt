#  MinHook - The Minimalistic API Hooking Library for x64/x86
#  Copyright (C) 2009-2017 Tsuda Kageyu.
#  All rights reserved.
#
#  Redistribution and use in source and binary forms, with or without
#  modification, are permitted provided that the following conditions
#  are met:
#
#   1. Redistributions of source code must retain the above copyright
#      notice, this list of conditions and the following disclaimer.
#   2. Redistributions in binary form must reproduce the above copyright
#      notice, this list of conditions and the following disclaimer in the
#      documentation and/or other materials provided with the distribution.
#
#  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
#  "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
#  TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
#  PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER
#  OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
#  EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
#  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
#  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
#  LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
#  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
#  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

cmake_minimum_required(VERSION 3.0...3.5)

project(antigravity-proxy LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(STATIC_RUNTIME "使用静态运行库(/MT)，减少运行库依赖" ON)

if(MSVC)
    add_compile_options(/utf-8)
    # 根据开关选择静态/动态运行库，减少运行库缺失导致的启动失败
    if(STATIC_RUNTIME)
        set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    else()
        set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL$<$<CONFIG:Debug>:Debug>")
    endif()
    # 统一禁用 windows.h 的 min/max 宏，避免污染 C++ 标准库的 std::min/std::max
    add_compile_definitions(NOMINMAX)
endif()

include(CMakePackageConfigHelpers)

set(MINHOOK_MAJOR_VERSION 1)
set(MINHOOK_MINOR_VERSION 3)
set(MINHOOK_PATCH_VERSION 3)
set(MINHOOK_VERSION ${MINHOOK_MAJOR_VERSION}.${MINHOOK_MINOR_VERSION}.${MINHOOK_PATCH_VERSION})

################
#    BUILD     # 
################

option(BUILD_SHARED_LIBS "build shared version" OFF)

# MinHook Sources
set(SOURCES_MINHOOK 
  "src/buffer.c"
  "src/hook.c"
  "src/trampoline.c"
)

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(SOURCES_HDE "src/hde/hde64.c")
else()
  set(SOURCES_HDE "src/hde/hde32.c")
endif()

# Proxy Sources
set(SOURCES_PROXY
  "src/main.cpp"
  "src/hooks/Hooks.cpp"
  "src/proxy/VersionProxy.cpp"
  "src/update/UpdateChecker.cpp"
)

# Resources
if(BUILD_SHARED_LIBS)
  set(RESOURCES 
    "dll_resources/MinHook.rc"
    "dll_resources/MinHook.def"
  )
endif()

# Build antigravity-proxy DLL (输出名为 version.dll)
add_library(version SHARED ${SOURCES_MINHOOK} ${SOURCES_HDE} ${SOURCES_PROXY} ${RESOURCES})

# 设置模块定义文件 (导出 version.dll 函数)
if(MSVC)
  set_target_properties(version PROPERTIES
    LINK_FLAGS "/DEF:\"${CMAKE_CURRENT_SOURCE_DIR}/src/proxy/version.def\""
  )
else()
  target_link_options(version PRIVATE
    "-Wl,${CMAKE_CURRENT_SOURCE_DIR}/src/proxy/version.def"
  )
endif()

target_include_directories(version PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include/>
  $<INSTALL_INTERFACE:include>
)

target_include_directories(version PRIVATE "src/")
target_include_directories(version PRIVATE "src/hde/")

# Link WS2_32 / WinHTTP
target_link_libraries(version PRIVATE ws2_32 winhttp)

if(NOT MSVC AND STATIC_RUNTIME)
  target_link_options(version PRIVATE -static-libstdc++ -static-libgcc)
endif()

# Build Antigravity CLI shim (输出名为 dbghelp.dll)
add_library(dbghelp SHARED
  "src/proxy/DbgHelpShim.cpp"
)

# CLI shim 通过定义文件导出常用 DbgHelp API，内部再延迟转发到系统 DLL。
if(MSVC)
  set_target_properties(dbghelp PROPERTIES
    LINK_FLAGS "/DEF:\"${CMAKE_CURRENT_SOURCE_DIR}/src/proxy/dbghelp.def\""
  )
else()
  target_link_options(dbghelp PRIVATE
    "-Wl,${CMAKE_CURRENT_SOURCE_DIR}/src/proxy/dbghelp.def"
  )
endif()

# CLI 使用唯一文件名加载代理主体，避免与已加载的系统 version.dll 同名冲突。
add_dependencies(dbghelp version)
add_custom_command(TARGET dbghelp POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          $<TARGET_FILE:version>
          $<TARGET_FILE_DIR:dbghelp>/antigravity_proxy.dll
  COMMENT "复制 Antigravity CLI 代理主体"
)

if(WIN32)
  set_target_properties(version PROPERTIES PREFIX "")
  set_target_properties(dbghelp PROPERTIES PREFIX "")
  if(CMAKE_SIZEOF_VOID_P EQUAL 8)   
    set_target_properties(version PROPERTIES OUTPUT_NAME "version")
    set_target_properties(dbghelp PROPERTIES OUTPUT_NAME "dbghelp")
    set_target_properties(version PROPERTIES DEBUG_POSTFIX ".x64d")
    set_target_properties(dbghelp PROPERTIES DEBUG_POSTFIX ".x64d")
    set_target_properties(version PROPERTIES RELEASE_POSTFIX "")
    set_target_properties(dbghelp PROPERTIES RELEASE_POSTFIX "")
  else()
    set_target_properties(version PROPERTIES OUTPUT_NAME "version")
    set_target_properties(dbghelp PROPERTIES OUTPUT_NAME "dbghelp")
    set_target_properties(version PROPERTIES DEBUG_POSTFIX ".x32d")
    set_target_properties(dbghelp PROPERTIES DEBUG_POSTFIX ".x32d")
    set_target_properties(version PROPERTIES RELEASE_POSTFIX "")
    set_target_properties(dbghelp PROPERTIES RELEASE_POSTFIX "")
  endif()
endif()

###################
#    LAUNCHER     #
###################
if(WIN32)
  add_executable(AntigravityLauncher WIN32
    "src/launcher/AntigravityLauncher.cpp"
  )
  target_compile_definitions(AntigravityLauncher PRIVATE UNICODE _UNICODE)
  target_link_libraries(AntigravityLauncher PRIVATE shell32 ole32 comdlg32 advapi32 user32)
  if(NOT MSVC AND STATIC_RUNTIME)
    target_link_options(AntigravityLauncher PRIVATE -static-libstdc++ -static-libgcc -municode)
  endif()
endif()

###################
#     INSTALL     #
###################
install(TARGETS version dbghelp RUNTIME DESTINATION "bin")

###################
#      TESTS      #
###################
option(BUILD_TESTS "构建单元测试（默认关闭）" OFF)
if(BUILD_TESTS)
  enable_testing()
  add_executable(antigravity_tests
    "tests/test_ipv6_parser.cpp"
  )
  target_include_directories(antigravity_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
  )
  target_link_libraries(antigravity_tests PRIVATE ws2_32)
  add_test(NAME antigravity_tests COMMAND antigravity_tests)

  add_executable(process_name_tests
    "tests/test_process_name.cpp"
  )
  target_include_directories(process_name_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(NAME process_name_tests COMMAND process_name_tests)

  add_executable(udp_policy_tests
    "tests/test_udp_policy.cpp"
  )
  target_include_directories(udp_policy_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(NAME udp_policy_tests COMMAND udp_policy_tests)

  add_executable(socket_family_tests
    "tests/test_socket_family.cpp"
  )
  target_include_directories(socket_family_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  target_link_libraries(socket_family_tests PRIVATE ws2_32)
  add_test(NAME socket_family_tests COMMAND socket_family_tests)

  add_executable(local_target_policy_tests
    "tests/test_local_target_policy.cpp"
  )
  target_include_directories(local_target_policy_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  target_link_libraries(local_target_policy_tests PRIVATE ws2_32)
  add_test(NAME local_target_policy_tests COMMAND local_target_policy_tests)

  add_executable(dbghelp_shim_tests
    "tests/test_dbghelp_shim.cpp"
  )
  # 使用真实 CLI 进程名覆盖 shim 的代理主体加载分支。
  set_target_properties(dbghelp_shim_tests PROPERTIES OUTPUT_NAME "agy")
  add_dependencies(dbghelp_shim_tests dbghelp)
  add_test(
    NAME dbghelp_shim_tests
    COMMAND dbghelp_shim_tests "$<TARGET_FILE:dbghelp>"
  )
endif()
