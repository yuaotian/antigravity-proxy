// ArmHook.cpp
// ARM64 版 MinHook 兼容层：用 Microsoft Detours 实现 MinHook.h 中项目用到的 API。
// MinHook 本身不支持 ARM64，因此仅在 ARM64 构建时编译本文件。
//
// 语义对齐 MinHook：
//   - MH_CreateHook 后 *ppOriginal 立即可用（调用它等于执行原函数），hook 处于禁用状态；
//   - MH_EnableHook / MH_DisableHook 切换到 detour / 回到原函数。
// 实现方式：创建时就用 Detours 把目标函数跳转到一个“闸门”stub，闸门默认转发到
// Detours 生成的 trampoline（等价于未 hook）；启用时把闸门目的地改为 detour。
// 这样 ppOriginal 在启用前后都稳定有效，切换只需一次原子指针写入。

#if defined(_M_ARM64)

#include <MinHook.h>
#include <detours.h>
#include <tlhelp32.h>

#include <atomic>
#include <mutex>
#include <vector>

namespace {

// 闸门 stub 布局（16 字节，8 字节对齐以保证原子写与 ldr 安全性）:
//   ldr x16, #8      ; 读取下面 8 字节的目的地
//   br  x16
//   .quad dest       ; 原子可写的目的地
struct alignas(8) Gate {
    UINT32 ldr;
    UINT32 br;
    std::atomic<ULONG_PTR> dest;
};
static_assert(sizeof(Gate) == 16 && alignof(Gate) >= 8,
              "Gate must be 16 bytes and at least 8-byte aligned");

struct HookEntry {
    LPVOID target = nullptr;       // 原函数地址（调用方传入）
    LPVOID detour = nullptr;       // 用户 detour
    LPVOID trampoline = nullptr;   // Detours 生成的 trampoline = 原函数入口
    Gate* gate = nullptr;
    bool enabled = false;
    bool queuedEnable = false;
    bool queuedValid = false;      // 是否有排队操作
};

std::mutex g_mutex;
bool g_initialized = false;
std::vector<HookEntry> g_hooks;

struct ScopedThreadHandles {
    std::vector<HANDLE> handles;
    ~ScopedThreadHandles() {
        for (HANDLE h : handles) {
            CloseHandle(h);
        }
    }
};

// 在 Detour 事务提交前挂起同进程其它线程，避免修改函数入口字节时出现执行撕裂
void UpdateOtherThreads(ScopedThreadHandles& out) {
    const DWORD pid = GetCurrentProcessId();
    const DWORD tid = GetCurrentThreadId();
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return;

    THREADENTRY32 te{};
    te.dwSize = sizeof(te);
    if (Thread32First(snap, &te)) {
        do {
            if (te.dwSize >= FIELD_OFFSET(THREADENTRY32, th32OwnerProcessID) +
                                 sizeof(te.th32OwnerProcessID) &&
                te.th32OwnerProcessID == pid && te.th32ThreadID != tid) {
                HANDLE hThread = OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_SET_CONTEXT,
                    FALSE, te.th32ThreadID);
                if (hThread) {
                    if (DetourUpdateThread(hThread) == NO_ERROR) {
                        out.handles.push_back(hThread);
                    } else {
                        CloseHandle(hThread);
                    }
                }
            }
            te.dwSize = sizeof(te);
        } while (Thread32Next(snap, &te));
    }
    CloseHandle(snap);
}

// 简单的闸门分配器：一次申请一页 RWX，切片使用；写入指令后刷新 ARM64 指令缓存
Gate* AllocGate() {
    static Gate* page = nullptr;
    static size_t used = 0;
    constexpr size_t kPageSize = 4096;
    if (!page || (used + 1) * sizeof(Gate) > kPageSize) {
        page = static_cast<Gate*>(VirtualAlloc(nullptr, kPageSize, MEM_COMMIT | MEM_RESERVE,
                                               PAGE_EXECUTE_READWRITE));
        used = 0;
        if (!page) return nullptr;
    }
    Gate* g = &page[used++];
    g->ldr = 0x58000050;  // ldr x16, #8
    g->br = 0xD61F0200;   // br x16
    FlushInstructionCache(GetCurrentProcess(), g, sizeof(Gate));
    return g;
}

HookEntry* Find(LPVOID target) {
    for (auto& h : g_hooks) {
        if (h.target == target) return &h;
    }
    return nullptr;
}

void SetGate(HookEntry& h, bool enable) {
    h.gate->dest.store(reinterpret_cast<ULONG_PTR>(enable ? h.detour : h.trampoline),
                       std::memory_order_release);
    h.enabled = enable;
}

MH_STATUS ApplyOne(HookEntry& h, bool enable) {
    if (h.enabled == enable) return enable ? MH_ERROR_ENABLED : MH_ERROR_DISABLED;
    SetGate(h, enable);
    return MH_OK;
}

}  // namespace

extern "C" {

MH_STATUS WINAPI MH_Initialize(VOID) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (g_initialized) return MH_ERROR_ALREADY_INITIALIZED;
    DetourSetRetainRegions(TRUE);
    g_initialized = true;
    return MH_OK;
}

MH_STATUS WINAPI MH_Uninitialize(VOID) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (!g_initialized) return MH_ERROR_NOT_INITIALIZED;

    // 先回到透传，再摘除 Detours 补丁
    for (auto& h : g_hooks) {
        if (h.enabled) SetGate(h, false);
    }
    if (!g_hooks.empty()) {
        ScopedThreadHandles threads;
        if (DetourTransactionBegin() == NO_ERROR) {
            UpdateOtherThreads(threads);
            for (auto& h : g_hooks) {
                PVOID tramp = h.trampoline;
                DetourDetach(&tramp, h.gate);
            }
            DetourTransactionCommit();
        }
    }
    // 闸门/trampoline 内存故意不释放：其他线程可能仍在其中执行。
    g_hooks.clear();
    g_initialized = false;
    return MH_OK;
}

MH_STATUS WINAPI MH_CreateHook(LPVOID pTarget, LPVOID pDetour, LPVOID* ppOriginal) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (!g_initialized) return MH_ERROR_NOT_INITIALIZED;
    if (!pTarget || !pDetour) return MH_ERROR_NOT_EXECUTABLE;
    if (Find(pTarget)) return MH_ERROR_ALREADY_CREATED;

    MEMORY_BASIC_INFORMATION mbi{};
    if (VirtualQuery(pTarget, &mbi, sizeof(mbi)) == 0 ||
        !(mbi.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                         PAGE_EXECUTE_WRITECOPY))) {
        return MH_ERROR_NOT_EXECUTABLE;
    }

    Gate* gate = AllocGate();
    if (!gate) return MH_ERROR_MEMORY_ALLOC;

    PVOID tramp = pTarget;
    PDETOUR_TRAMPOLINE realTramp = nullptr;
    ScopedThreadHandles threads;
    LONG err = DetourTransactionBegin();
    if (err != NO_ERROR) return MH_UNKNOWN;
    UpdateOtherThreads(threads);
    err = DetourAttachEx(&tramp, gate, &realTramp, nullptr, nullptr);
    if (err != NO_ERROR) {
        DetourTransactionAbort();
        return err == ERROR_NOT_ENOUGH_MEMORY ? MH_ERROR_MEMORY_ALLOC
                                              : MH_ERROR_UNSUPPORTED_FUNCTION;
    }
    if (realTramp) {
        // Commit 内部会先修改目标函数并恢复被挂起线程再返回；提前写入 trampoline（即 rbCode 首地址），
        // 消除 Commit 返回前闸门 dest 为 0 的竞争窗口。
        gate->dest.store(reinterpret_cast<ULONG_PTR>(realTramp), std::memory_order_release);
    }
    err = DetourTransactionCommit();
    if (err != NO_ERROR) return MH_ERROR_MEMORY_PROTECT;

    HookEntry h;
    h.target = pTarget;
    h.detour = pDetour;
    h.trampoline = tramp;
    h.gate = gate;
    gate->dest.store(reinterpret_cast<ULONG_PTR>(tramp), std::memory_order_release);
    g_hooks.push_back(h);

    if (ppOriginal) *ppOriginal = tramp;
    return MH_OK;
}

MH_STATUS WINAPI MH_CreateHookApiEx(LPCWSTR pszModule, LPCSTR pszProcName, LPVOID pDetour,
                                    LPVOID* ppOriginal, LPVOID* ppTarget) {
    HMODULE hModule = GetModuleHandleW(pszModule);
    if (!hModule) return MH_ERROR_MODULE_NOT_FOUND;
    LPVOID pTarget = reinterpret_cast<LPVOID>(GetProcAddress(hModule, pszProcName));
    if (!pTarget) return MH_ERROR_FUNCTION_NOT_FOUND;
    if (ppTarget) *ppTarget = pTarget;
    return MH_CreateHook(pTarget, pDetour, ppOriginal);
}

MH_STATUS WINAPI MH_CreateHookApi(LPCWSTR pszModule, LPCSTR pszProcName, LPVOID pDetour,
                                  LPVOID* ppOriginal) {
    return MH_CreateHookApiEx(pszModule, pszProcName, pDetour, ppOriginal, nullptr);
}

MH_STATUS WINAPI MH_RemoveHook(LPVOID pTarget) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (!g_initialized) return MH_ERROR_NOT_INITIALIZED;
    if (pTarget == MH_ALL_HOOKS) return MH_ERROR_NOT_CREATED;
    HookEntry* h = Find(pTarget);
    if (!h) return MH_ERROR_NOT_CREATED;
    if (h->enabled) SetGate(*h, false);
    {
        ScopedThreadHandles threads;
        if (DetourTransactionBegin() == NO_ERROR) {
            UpdateOtherThreads(threads);
            PVOID tramp = h->trampoline;
            DetourDetach(&tramp, h->gate);
            DetourTransactionCommit();
        }
    }
    g_hooks.erase(g_hooks.begin() + (h - g_hooks.data()));
    return MH_OK;
}

static MH_STATUS ForEach(LPVOID pTarget, bool enable) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (!g_initialized) return MH_ERROR_NOT_INITIALIZED;
    if (pTarget == MH_ALL_HOOKS) {
        for (auto& h : g_hooks) {
            if (h.enabled != enable) SetGate(h, enable);
        }
        return MH_OK;
    }
    HookEntry* h = Find(pTarget);
    if (!h) return MH_ERROR_NOT_CREATED;
    return ApplyOne(*h, enable);
}

MH_STATUS WINAPI MH_EnableHook(LPVOID pTarget) { return ForEach(pTarget, true); }
MH_STATUS WINAPI MH_DisableHook(LPVOID pTarget) { return ForEach(pTarget, false); }

static MH_STATUS Queue(LPVOID pTarget, bool enable) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (!g_initialized) return MH_ERROR_NOT_INITIALIZED;
    if (pTarget == MH_ALL_HOOKS) {
        for (auto& h : g_hooks) {
            h.queuedValid = true;
            h.queuedEnable = enable;
        }
        return MH_OK;
    }
    HookEntry* h = Find(pTarget);
    if (!h) return MH_ERROR_NOT_CREATED;
    h->queuedValid = true;
    h->queuedEnable = enable;
    return MH_OK;
}

MH_STATUS WINAPI MH_QueueEnableHook(LPVOID pTarget) { return Queue(pTarget, true); }
MH_STATUS WINAPI MH_QueueDisableHook(LPVOID pTarget) { return Queue(pTarget, false); }

MH_STATUS WINAPI MH_ApplyQueued(VOID) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (!g_initialized) return MH_ERROR_NOT_INITIALIZED;
    for (auto& h : g_hooks) {
        if (h.queuedValid && h.enabled != h.queuedEnable) SetGate(h, h.queuedEnable);
        h.queuedValid = false;
    }
    return MH_OK;
}

const char* WINAPI MH_StatusToString(MH_STATUS status) {
    switch (status) {
        case MH_OK: return "MH_OK";
        case MH_ERROR_ALREADY_INITIALIZED: return "MH_ERROR_ALREADY_INITIALIZED";
        case MH_ERROR_NOT_INITIALIZED: return "MH_ERROR_NOT_INITIALIZED";
        case MH_ERROR_ALREADY_CREATED: return "MH_ERROR_ALREADY_CREATED";
        case MH_ERROR_NOT_CREATED: return "MH_ERROR_NOT_CREATED";
        case MH_ERROR_ENABLED: return "MH_ERROR_ENABLED";
        case MH_ERROR_DISABLED: return "MH_ERROR_DISABLED";
        case MH_ERROR_NOT_EXECUTABLE: return "MH_ERROR_NOT_EXECUTABLE";
        case MH_ERROR_UNSUPPORTED_FUNCTION: return "MH_ERROR_UNSUPPORTED_FUNCTION";
        case MH_ERROR_MEMORY_ALLOC: return "MH_ERROR_MEMORY_ALLOC";
        case MH_ERROR_MEMORY_PROTECT: return "MH_ERROR_MEMORY_PROTECT";
        case MH_ERROR_MODULE_NOT_FOUND: return "MH_ERROR_MODULE_NOT_FOUND";
        case MH_ERROR_FUNCTION_NOT_FOUND: return "MH_ERROR_FUNCTION_NOT_FOUND";
        default: return "MH_UNKNOWN";
    }
}

}  // extern "C"

#endif  // _M_ARM64
