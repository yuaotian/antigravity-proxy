// 防止 windows.h 自动包含 winsock.h (避免与 winsock2.h 冲突)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include "core/Config.hpp"
#include "core/Logger.hpp"

// 前向声明
namespace Hooks {
    void Install();
    void Uninstall();
}

namespace VersionProxy {
    bool Initialize();
    void Uninitialize();
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    switch (fdwReason) {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hinstDLL);
        
        // 初始化 version.dll 代理 (必须最先执行)
        if (!VersionProxy::Initialize()) {
            // 即使代理初始化失败，也继续运行以避免程序崩溃 (Fail-Safe)
            Core::Logger::Error("VersionProxy initialization failed");
        }
        
        Core::Logger::Info("Antigravity-Proxy DLL Loaded (as version.dll)");
        
        // 加载配置
        Core::Config::Instance().Load("config.json");
        
        // 安装 Hooks
        Hooks::Install();
        break;
        
    case DLL_PROCESS_DETACH:
        Hooks::Uninstall();
        VersionProxy::Uninitialize();
        Core::Logger::Info("Antigravity-Proxy DLL Unloaded");
        break;
    }
    return TRUE;
}
