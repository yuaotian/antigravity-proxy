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
set_target_properties(version PROPERTIES
  LINK_FLAGS "/DEF:\"${CMAKE_CURRENT_SOURCE_DIR}/src/proxy/version.def\""
)

target_include_directories(version PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include/>
  $<INSTALL_INTERFACE:include>
)

target_include_directories(version PRIVATE "src/")
target_include_directories(version PRIVATE "src/hde/")

# Link WS2_32
target_link_libraries(version PRIVATE ws2_32)

if(WIN32)
  set_target_properties(version PROPERTIES PREFIX "")
  if(CMAKE_SIZEOF_VOID_P EQUAL 8)   
    set_target_properties(version PROPERTIES OUTPUT_NAME "version")
    set_target_properties(version PROPERTIES DEBUG_POSTFIX ".x64d")
    set_target_properties(version PROPERTIES RELEASE_POSTFIX "")
  else()
    set_target_properties(version PROPERTIES OUTPUT_NAME "version")
    set_target_properties(version PROPERTIES DEBUG_POSTFIX ".x32d")
    set_target_properties(version PROPERTIES RELEASE_POSTFIX "")
  endif()
endif()

###################
#     INSTALL     #
###################
install(TARGETS version RUNTIME DESTINATION "bin")
