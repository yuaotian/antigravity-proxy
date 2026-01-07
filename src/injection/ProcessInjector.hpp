#pragma once

// 防止 windows.h 自动包含 winsock.h (避免与 winsock2.h 冲突)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <string>
#include "../core/Logger.hpp"

namespace Injection {
    
    // 进程注入器
    // 用于将 DLL 注入到子进程中
    class ProcessInjector {
    public:
        // 注入 DLL 到目标进程
        // hProcess: 目标进程句柄 (需要 PROCESS_ALL_ACCESS 权限)
        // dllPath: 要注入的 DLL 完整路径
        // 返回: 成功返回 true
        static bool InjectDll(HANDLE hProcess, const std::wstring& dllPath) {
            // 步骤 1: 在目标进程中分配内存
            SIZE_T dllPathSize = (dllPath.length() + 1) * sizeof(wchar_t);
            LPVOID remoteDllPath = VirtualAllocEx(
                hProcess,
                NULL,
                dllPathSize,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE
            );
            
            if (!remoteDllPath) {
                Core::Logger::Error("ProcessInjector: VirtualAllocEx failed");
                return false;
            }
            
            // 步骤 2: 将 DLL 路径写入目标进程
            if (!WriteProcessMemory(hProcess, remoteDllPath, dllPath.c_str(), dllPathSize, NULL)) {
                Core::Logger::Error("ProcessInjector: WriteProcessMemory failed");
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
                return false;
            }
            
            // 步骤 3: 获取 LoadLibraryW 地址 (Kernel32.dll 在所有进程中地址相同)
            HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
            if (!hKernel32) {
                Core::Logger::Error("ProcessInjector: GetModuleHandleW(kernel32) failed");
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
                return false;
            }
            
            LPTHREAD_START_ROUTINE loadLibraryAddr = 
                (LPTHREAD_START_ROUTINE)GetProcAddress(hKernel32, "LoadLibraryW");
            if (!loadLibraryAddr) {
                Core::Logger::Error("ProcessInjector: GetProcAddress(LoadLibraryW) failed");
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
                return false;
            }
            
            // 步骤 4: 创建远程线程调用 LoadLibraryW
            HANDLE hThread = CreateRemoteThread(
                hProcess,
                NULL,
                0,
                loadLibraryAddr,
                remoteDllPath,
                0,
                NULL
            );
            
            if (!hThread) {
                Core::Logger::Error("ProcessInjector: CreateRemoteThread failed");
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
                return false;
            }
            
            // 步骤 5: 等待注入完成
            WaitForSingleObject(hThread, 5000); // 最多等待 5 秒
            
            // 清理
            CloseHandle(hThread);
            VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
            
            Core::Logger::Info("ProcessInjector: DLL injected successfully");
            return true;
        }
        
        // 获取当前 DLL 的完整路径
        static std::wstring GetCurrentDllPath() {
            wchar_t path[MAX_PATH];
            HMODULE hModule = NULL;
            
            // 获取当前 DLL 的句柄
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                (LPCWSTR)&GetCurrentDllPath,
                &hModule
            );
            
            if (hModule && GetModuleFileNameW(hModule, path, MAX_PATH)) {
                return std::wstring(path);
            }
            
            return L"";
        }
    };
}
