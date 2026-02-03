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
                Core::Logger::Error("ProcessInjector: 虚拟内存分配失败 (VirtualAllocEx failed)");
                return false;
            }
            
            // 步骤 2: 将 DLL 路径写入目标进程
            if (!WriteProcessMemory(hProcess, remoteDllPath, dllPath.c_str(), dllPathSize, NULL)) {
                Core::Logger::Error("ProcessInjector: 写入进程内存失败 (WriteProcessMemory failed)");
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
                return false;
            }
            
            // 步骤 3: 获取 LoadLibraryW 地址 (Kernel32.dll 在所有进程中地址相同)
            HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
            if (!hKernel32) {
                Core::Logger::Error("ProcessInjector: 获取 Kernel32 句柄失败");
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
                return false;
            }
            
            LPTHREAD_START_ROUTINE loadLibraryAddr = 
                (LPTHREAD_START_ROUTINE)GetProcAddress(hKernel32, "LoadLibraryW");
            if (!loadLibraryAddr) {
                Core::Logger::Error("ProcessInjector: 获取 LoadLibraryW 地址失败");
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
                Core::Logger::Error("ProcessInjector: 创建远程线程失败 (CreateRemoteThread failed)");
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
                return false;
            }
            
            // 步骤 5: 等待注入完成
            DWORD waitRc = WaitForSingleObject(hThread, 5000); // 最多等待 5 秒

            bool ok = false;
            DWORD exitCode = 0;

            if (waitRc == WAIT_OBJECT_0) {
                // 注意：GetExitCodeThread 返回 DWORD；在 64 位进程中我们仅用它判断是否为 0（NULL）
                if (GetExitCodeThread(hThread, &exitCode)) {
                    ok = (exitCode != 0 && exitCode != STILL_ACTIVE);
                } else {
                    DWORD err = GetLastError();
                    Core::Logger::Warn("ProcessInjector: 获取远程线程退出码失败 (GetExitCodeThread failed), err=" + std::to_string(err));
                }
            } else if (waitRc == WAIT_TIMEOUT) {
                // 超时意味着远程线程可能仍在读取 remoteDllPath；此时释放远程内存可能导致 UAF
                Core::Logger::Warn("ProcessInjector: 等待远程线程超时(5000ms)，注入结果未知；为避免 UAF 将不释放远程路径内存");
            } else {
                DWORD err = GetLastError();
                Core::Logger::Error("ProcessInjector: 等待远程线程失败 (WaitForSingleObject failed), rc=" + std::to_string(waitRc) +
                                    ", err=" + std::to_string(err));
            }

            // 清理：句柄必须关闭；远程路径内存仅在远程线程结束后释放，避免 UAF
            CloseHandle(hThread);
            if (waitRc == WAIT_OBJECT_0) {
                VirtualFreeEx(hProcess, remoteDllPath, 0, MEM_RELEASE);
            }

            if (ok) {
                Core::Logger::Info("ProcessInjector: 注入成功 (LoadLibraryW 返回非空)");
                return true;
            }
            if (waitRc == WAIT_OBJECT_0) {
                Core::Logger::Error("ProcessInjector: 注入失败 (LoadLibraryW 返回 0)");
            }
            return false;
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
