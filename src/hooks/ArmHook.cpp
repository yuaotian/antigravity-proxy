// ArmHook.cpp
// ARM64 版 MinHook 兼容层：用 Microsoft Detours 实现 MinHook.h 中项目用到的 API。
// MinHook 本身不支持 ARM64，因此仅在 ARM64 构建时编译本文件。
//
// 设计要点：
// 1. 语义对齐 MinHook：
//    - MH_CreateHook 后 *ppOriginal 立即可用（启用前调用它等价于直接调用原函数），且不挂起线程；
//    - MH_EnableHook / MH_ApplyQueued 时在单个 Detours 事务内批量完成首次挂载，启动阶段只需挂起一次其它线程；
//    - 已挂载的 Hook 在启用/禁用之间切换只需对闸门（Gate）执行一次原子指针写入，无需再次挂起线程。
// 2. 挂起线程期间零默认堆分配：
//    - 本模块内部容器与线程句柄缓冲全部使用独立私有堆（HeapCreate），不使用进程默认堆（GetProcessHeap）；
//    - Detours 事务的 DetourAttachEx / DetourDetach 在挂起其它线程之前完成；
//    - Detours 内部事务节点（DetourThread / DetourOperation）同样使用独立私有堆，避免被挂起线程持有默认堆锁导致启动死锁。

#if defined(_M_ARM64)

#include <MinHook.h>
#include <detours.h>
#include <tlhelp32.h>

#include <atomic>
#include <cstring>

namespace {

constexpr size_t kInvalidIndex = static_cast<size_t>(-1);

// 16 字节可执行跳板（8 字节对齐以保证 ldr 与原子写安全）:
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
    LPVOID target;         // 原函数地址（调用方传入）
    LPVOID detour;         // 用户 detour
    LPVOID trampoline;     // Detours 生成的 trampoline（首次挂载后有效）
    Gate* gate;            // 目标函数被 Detours 改写后跳入此闸门
    Gate* callerStub;      // 作为 *ppOriginal 返回给调用方：挂载前指向 target，挂载后指向 trampoline
    bool attached;         // 是否已通过 Detours 改写目标函数入口
    bool attachFailed;     // 批量挂载时该目标是否因指令不支持而失败
    bool enabled;          // 当前是否处于启用状态
    bool queuedEnable;     // 排队目标状态
    bool queuedValid;      // 是否有排队操作
};

SRWLOCK g_lock = SRWLOCK_INIT;
HANDLE g_hHeap = nullptr;
HookEntry* g_hooks = nullptr;
size_t g_hookCount = 0;
size_t g_hookCap = 0;

struct ScopedSrwLock {
    ScopedSrwLock() noexcept { AcquireSRWLockExclusive(&g_lock); }
    ~ScopedSrwLock() noexcept { ReleaseSRWLockExclusive(&g_lock); }
};

bool IsExecutableAddress(LPVOID address) noexcept {
    if (!address) return false;
    MEMORY_BASIC_INFORMATION mbi{};
    if (VirtualQuery(address, &mbi, sizeof(mbi)) == 0) return false;
    return mbi.State == MEM_COMMIT &&
           (mbi.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                           PAGE_EXECUTE_WRITECOPY)) != 0;
}

// 跳板分配器：一次通过 VirtualAlloc 申请一页 RWX 切片使用，写入指令后刷新 ARM64 指令缓存
Gate* AllocGate(ULONG_PTR initialDest) noexcept {
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
    g->dest.store(initialDest, std::memory_order_relaxed);
    FlushInstructionCache(GetCurrentProcess(), g, sizeof(Gate));
    return g;
}

size_t FindHookIndex(LPVOID target) noexcept {
    for (size_t i = 0; i < g_hookCount; ++i) {
        if (g_hooks[i].target == target) return i;
    }
    return kInvalidIndex;
}

HookEntry* AppendHookEntry() noexcept {
    if (g_hookCount == g_hookCap) {
        const size_t newCap = g_hookCap == 0 ? 32 : g_hookCap * 2;
        const size_t bytes = newCap * sizeof(HookEntry);
        void* mem = g_hooks
                        ? HeapReAlloc(g_hHeap, 0, g_hooks, bytes)
                        : HeapAlloc(g_hHeap, 0, bytes);
        if (!mem) return nullptr;
        g_hooks = static_cast<HookEntry*>(mem);
        g_hookCap = newCap;
    }
    HookEntry* entry = &g_hooks[g_hookCount++];
    std::memset(entry, 0, sizeof(*entry));
    return entry;
}

void SetGate(HookEntry& h, bool enable) noexcept {
    h.gate->dest.store(reinterpret_cast<ULONG_PTR>(enable ? h.detour : h.trampoline),
                       std::memory_order_release);
    h.enabled = enable;
}

// 私有堆上的线程句柄数组：在挂起任何线程前一次性收集句柄，避免挂起期间扩容或走默认堆
class ScopedThreadHandles {
public:
    explicit ScopedThreadHandles(HANDLE heap) noexcept : heap_(heap) {}
    ~ScopedThreadHandles() noexcept {
        for (size_t i = 0; i < count_; ++i) {
            if (handles_[i]) CloseHandle(handles_[i]);
        }
        if (handles_ && heap_) {
            HeapFree(heap_, 0, handles_);
        }
    }

    ScopedThreadHandles(const ScopedThreadHandles&) = delete;
    ScopedThreadHandles& operator=(const ScopedThreadHandles&) = delete;

    bool PushBeforeSuspend(HANDLE h) noexcept {
        if (count_ == cap_) {
            const size_t newCap = cap_ == 0 ? 128 : cap_ * 2;
            const size_t bytes = newCap * sizeof(HANDLE);
            void* mem = handles_
                            ? HeapReAlloc(heap_, 0, handles_, bytes)
                            : HeapAlloc(heap_, 0, bytes);
            if (!mem) return false;
            handles_ = static_cast<HANDLE*>(mem);
            cap_ = newCap;
        }
        handles_[count_++] = h;
        return true;
    }

    size_t Count() const noexcept { return count_; }
    HANDLE At(size_t i) const noexcept { return handles_[i]; }
    void ClearAt(size_t i) noexcept { handles_[i] = nullptr; }

private:
    HANDLE heap_ = nullptr;
    HANDLE* handles_ = nullptr;
    size_t count_ = 0;
    size_t cap_ = 0;
};

// 先枚举并打开同进程其它线程句柄（此时尚未挂起任何线程），再交由 DetourUpdateThread 逐一挂起。
// 返回 false 表示某线程在枚举与挂起之间恰好退出导致 Detours 事务被标记失败，调用方应中止事务并重试。
bool CollectAndSuspendOtherThreads(ScopedThreadHandles& out) noexcept {
    const DWORD pid = GetCurrentProcessId();
    const DWORD tid = GetCurrentThreadId();
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return true;

    THREADENTRY32 te{};
    te.dwSize = sizeof(te);
    if (Thread32First(snap, &te)) {
        do {
            if (te.dwSize >= FIELD_OFFSET(THREADENTRY32, th32OwnerProcessID) +
                                 sizeof(te.th32OwnerProcessID) &&
                te.th32OwnerProcessID == pid && te.th32ThreadID != tid) {
                HANDLE hThread = OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | SYNCHRONIZE,
                    FALSE, te.th32ThreadID);
                if (hThread) {
                    if (!out.PushBeforeSuspend(hThread)) {
                        CloseHandle(hThread);
                    }
                }
            }
            te.dwSize = sizeof(te);
        } while (Thread32Next(snap, &te));
    }
    CloseHandle(snap);

    // 枚举完毕后再统一挂起；DetourThread 节点从 Detours 独立事务私有堆分配，不触碰进程默认堆
    for (size_t i = 0; i < out.Count(); ++i) {
        HANDLE hThread = out.At(i);
        if (!hThread) continue;
        // 线程已退出时直接跳过，避免 DetourUpdateThread 因 SuspendThread 失败而毒化整笔事务
        if (WaitForSingleObject(hThread, 0) == WAIT_OBJECT_0) {
            CloseHandle(hThread);
            out.ClearAt(i);
            continue;
        }
        if (DetourUpdateThread(hThread) != NO_ERROR) {
            CloseHandle(hThread);
            out.ClearAt(i);
            return false;
        }
    }
    return true;
}

// 在单个 Detours 事务内批量完成首次挂载并启用
MH_STATUS AttachAndEnableBatch(const size_t* indices, size_t count) noexcept {
    if (count == 0) return MH_OK;

    struct Slot {
        size_t hookIdx;
        PVOID tramp;
        PDETOUR_TRAMPOLINE realTramp;
        bool skipped;
    };

    Slot* slots = static_cast<Slot*>(HeapAlloc(g_hHeap, HEAP_ZERO_MEMORY, count * sizeof(Slot)));
    if (!slots) return MH_ERROR_MEMORY_ALLOC;

    for (size_t i = 0; i < count; ++i) {
        slots[i].hookIdx = indices[i];
    }

    MH_STATUS result = MH_OK;
    constexpr int kMaxSuspendRetries = 8;
    int suspendRetries = 0;

    for (;;) {
        size_t activeCount = 0;
        for (size_t i = 0; i < count; ++i) {
            if (!slots[i].skipped) ++activeCount;
        }
        if (activeCount == 0) break;

        LONG err = DetourTransactionBegin();
        if (err != NO_ERROR) {
            result = err == ERROR_NOT_ENOUGH_MEMORY ? MH_ERROR_MEMORY_ALLOC : MH_UNKNOWN;
            break;
        }

        bool needRetry = false;
        for (size_t i = 0; i < count; ++i) {
            if (slots[i].skipped) continue;
            HookEntry& h = g_hooks[slots[i].hookIdx];
            slots[i].tramp = h.target;
            slots[i].realTramp = nullptr;

            // 在挂起任何线程前先完成反汇编、trampoline 分配与页面属性准备
            err = DetourAttachEx(&slots[i].tramp, h.gate, &slots[i].realTramp, nullptr, nullptr);
            if (err != NO_ERROR) {
                DetourTransactionAbort();
                const MH_STATUS mapped = err == ERROR_NOT_ENOUGH_MEMORY
                                             ? MH_ERROR_MEMORY_ALLOC
                                             : MH_ERROR_UNSUPPORTED_FUNCTION;
                h.attachFailed = true;
                slots[i].skipped = true;
                result = mapped;
                if (count > 1) {
                    needRetry = true;
                }
                break;
            }
        }

        if (needRetry) continue;
        if (err != NO_ERROR) break;

        {
            ScopedThreadHandles threads(g_hHeap);
            if (!CollectAndSuspendOtherThreads(threads)) {
                // 在修改 callerStub/gate 前先中止并恢复其它线程，保证窗口期 *ppOriginal 仍直指原函数
                DetourTransactionAbort();
                if (++suspendRetries < kMaxSuspendRetries) {
                    continue;
                }
                result = MH_UNKNOWN;
                break;
            }

            // 所有其它线程已挂起，且 Commit 会在恢复线程前刷新目标函数与 trampoline 指令缓存
            for (size_t i = 0; i < count; ++i) {
                if (slots[i].skipped) continue;
                HookEntry& h = g_hooks[slots[i].hookIdx];
                if (slots[i].realTramp) {
                    h.callerStub->dest.store(reinterpret_cast<ULONG_PTR>(slots[i].realTramp),
                                             std::memory_order_release);
                }
                h.gate->dest.store(reinterpret_cast<ULONG_PTR>(h.detour), std::memory_order_release);
            }

            err = DetourTransactionCommit();
            if (err != NO_ERROR) {
                for (size_t i = 0; i < count; ++i) {
                    if (slots[i].skipped) continue;
                    HookEntry& h = g_hooks[slots[i].hookIdx];
                    h.callerStub->dest.store(reinterpret_cast<ULONG_PTR>(h.target),
                                             std::memory_order_release);
                    h.gate->dest.store(reinterpret_cast<ULONG_PTR>(h.target),
                                       std::memory_order_release);
                }
                result = MH_ERROR_MEMORY_PROTECT;
                break;
            }
        }

        for (size_t i = 0; i < count; ++i) {
            if (slots[i].skipped) continue;
            HookEntry& h = g_hooks[slots[i].hookIdx];
            h.trampoline = slots[i].tramp;
            h.callerStub->dest.store(reinterpret_cast<ULONG_PTR>(slots[i].tramp),
                                     std::memory_order_release);
            h.attached = true;
            h.enabled = true;
        }
        break;
    }

    HeapFree(g_hHeap, 0, slots);
    return result;
}

}  // namespace

extern "C" {

MH_STATUS WINAPI MH_Initialize(VOID) {
    ScopedSrwLock lk;
    if (g_hHeap) return MH_ERROR_ALREADY_INITIALIZED;
    g_hHeap = HeapCreate(0, 0, 0);
    if (!g_hHeap) return MH_ERROR_MEMORY_ALLOC;
    DetourSetRetainRegions(TRUE);
    return MH_OK;
}

MH_STATUS WINAPI MH_Uninitialize(VOID) {
    ScopedSrwLock lk;
    if (!g_hHeap) return MH_ERROR_NOT_INITIALIZED;

    // 先将所有闸门切回透传，再在单个事务内摘除全部已挂载的 Detours 补丁
    bool anyAttached = false;
    for (size_t i = 0; i < g_hookCount; ++i) {
        HookEntry& h = g_hooks[i];
        if (h.enabled) SetGate(h, false);
        if (h.attached) anyAttached = true;
    }

    if (anyAttached) {
        constexpr int kMaxSuspendRetries = 8;
        for (int attempt = 0; attempt < kMaxSuspendRetries; ++attempt) {
            if (DetourTransactionBegin() != NO_ERROR) break;
            LONG err = NO_ERROR;
            for (size_t i = 0; i < g_hookCount; ++i) {
                HookEntry& h = g_hooks[i];
                if (!h.attached) continue;
                PVOID tramp = h.trampoline;
                err = DetourDetach(&tramp, h.gate);
                if (err != NO_ERROR) break;
            }
            if (err != NO_ERROR) {
                DetourTransactionAbort();
                break;
            }
            ScopedThreadHandles threads(g_hHeap);
            if (!CollectAndSuspendOtherThreads(threads)) {
                DetourTransactionAbort();
                continue;
            }
            for (size_t i = 0; i < g_hookCount; ++i) {
                HookEntry& h = g_hooks[i];
                if (h.attached) {
                    h.callerStub->dest.store(reinterpret_cast<ULONG_PTR>(h.target),
                                             std::memory_order_release);
                }
            }
            if (DetourTransactionCommit() != NO_ERROR) {
                // Commit 失败则目标仍带补丁，复位 callerStub 指向 trampoline 避免误触发循环跳转
                for (size_t i = 0; i < g_hookCount; ++i) {
                    HookEntry& h = g_hooks[i];
                    if (h.attached && h.trampoline) {
                        h.callerStub->dest.store(reinterpret_cast<ULONG_PTR>(h.trampoline),
                                                 std::memory_order_release);
                    }
                }
            }
            break;
        }
    }

    // 闸门/trampoline 可执行页故意保留不释放，防止极小概率仍有线程停留在跳板指令上
    if (g_hooks) {
        HeapFree(g_hHeap, 0, g_hooks);
        g_hooks = nullptr;
    }
    g_hookCount = 0;
    g_hookCap = 0;

    HeapDestroy(g_hHeap);
    g_hHeap = nullptr;
    return MH_OK;
}

MH_STATUS WINAPI MH_CreateHook(LPVOID pTarget, LPVOID pDetour, LPVOID* ppOriginal) {
    ScopedSrwLock lk;
    if (!g_hHeap) return MH_ERROR_NOT_INITIALIZED;
    if (!IsExecutableAddress(pTarget) || !IsExecutableAddress(pDetour)) {
        return MH_ERROR_NOT_EXECUTABLE;
    }
    if (FindHookIndex(pTarget) != kInvalidIndex) return MH_ERROR_ALREADY_CREATED;

    const ULONG_PTR targetAddr = reinterpret_cast<ULONG_PTR>(pTarget);
    Gate* gate = AllocGate(targetAddr);
    Gate* callerStub = AllocGate(targetAddr);
    if (!gate || !callerStub) return MH_ERROR_MEMORY_ALLOC;

    HookEntry* h = AppendHookEntry();
    if (!h) return MH_ERROR_MEMORY_ALLOC;

    h->target = pTarget;
    h->detour = pDetour;
    h->trampoline = nullptr;
    h->gate = gate;
    h->callerStub = callerStub;

    if (ppOriginal) *ppOriginal = callerStub;
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
    ScopedSrwLock lk;
    if (!g_hHeap) return MH_ERROR_NOT_INITIALIZED;
    if (pTarget == MH_ALL_HOOKS) return MH_ERROR_NOT_CREATED;
    const size_t idx = FindHookIndex(pTarget);
    if (idx == kInvalidIndex) return MH_ERROR_NOT_CREATED;

    HookEntry& h = g_hooks[idx];
    if (h.enabled) SetGate(h, false);
    if (h.attached) {
        bool detached = false;
        constexpr int kMaxSuspendRetries = 8;
        for (int attempt = 0; attempt < kMaxSuspendRetries; ++attempt) {
            if (DetourTransactionBegin() != NO_ERROR) break;
            PVOID tramp = h.trampoline;
            if (DetourDetach(&tramp, h.gate) != NO_ERROR) {
                DetourTransactionAbort();
                break;
            }
            ScopedThreadHandles threads(g_hHeap);
            if (!CollectAndSuspendOtherThreads(threads)) {
                DetourTransactionAbort();
                continue;
            }
            h.callerStub->dest.store(reinterpret_cast<ULONG_PTR>(h.target),
                                     std::memory_order_release);
            if (DetourTransactionCommit() == NO_ERROR) {
                detached = true;
            } else if (h.trampoline) {
                h.callerStub->dest.store(reinterpret_cast<ULONG_PTR>(h.trampoline),
                                         std::memory_order_release);
            }
            break;
        }
        if (!detached) {
            return MH_ERROR_MEMORY_PROTECT;
        }
    }

    if (idx + 1 < g_hookCount) {
        std::memmove(&g_hooks[idx], &g_hooks[idx + 1], (g_hookCount - idx - 1) * sizeof(HookEntry));
    }
    --g_hookCount;
    return MH_OK;
}

static MH_STATUS EnableOrDisable(LPVOID pTarget, bool enable) {
    ScopedSrwLock lk;
    if (!g_hHeap) return MH_ERROR_NOT_INITIALIZED;

    if (pTarget == MH_ALL_HOOKS) {
        if (!enable) {
            for (size_t i = 0; i < g_hookCount; ++i) {
                if (g_hooks[i].enabled) SetGate(g_hooks[i], false);
            }
            return MH_OK;
        }

        size_t* toAttach = g_hookCount
                               ? static_cast<size_t*>(HeapAlloc(g_hHeap, 0, g_hookCount * sizeof(size_t)))
                               : nullptr;
        if (g_hookCount && !toAttach) return MH_ERROR_MEMORY_ALLOC;

        size_t attachCount = 0;
        MH_STATUS status = MH_OK;
        for (size_t i = 0; i < g_hookCount; ++i) {
            HookEntry& h = g_hooks[i];
            if (h.enabled) continue;
            if (h.attached) {
                SetGate(h, true);
            } else if (!h.attachFailed) {
                toAttach[attachCount++] = i;
            } else {
                status = MH_ERROR_UNSUPPORTED_FUNCTION;
            }
        }

        if (attachCount > 0) {
            const MH_STATUS batchStatus = AttachAndEnableBatch(toAttach, attachCount);
            if (batchStatus != MH_OK) status = batchStatus;
        }
        if (toAttach) HeapFree(g_hHeap, 0, toAttach);
        return status;
    }

    const size_t idx = FindHookIndex(pTarget);
    if (idx == kInvalidIndex) return MH_ERROR_NOT_CREATED;
    HookEntry& h = g_hooks[idx];
    if (h.enabled == enable) return enable ? MH_ERROR_ENABLED : MH_ERROR_DISABLED;

    if (!enable || h.attached) {
        SetGate(h, enable);
        return MH_OK;
    }
    return AttachAndEnableBatch(&idx, 1);
}

MH_STATUS WINAPI MH_EnableHook(LPVOID pTarget) { return EnableOrDisable(pTarget, true); }
MH_STATUS WINAPI MH_DisableHook(LPVOID pTarget) { return EnableOrDisable(pTarget, false); }

static MH_STATUS Queue(LPVOID pTarget, bool enable) {
    ScopedSrwLock lk;
    if (!g_hHeap) return MH_ERROR_NOT_INITIALIZED;
    if (pTarget == MH_ALL_HOOKS) {
        for (size_t i = 0; i < g_hookCount; ++i) {
            g_hooks[i].queuedValid = true;
            g_hooks[i].queuedEnable = enable;
        }
        return MH_OK;
    }
    const size_t idx = FindHookIndex(pTarget);
    if (idx == kInvalidIndex) return MH_ERROR_NOT_CREATED;
    g_hooks[idx].queuedValid = true;
    g_hooks[idx].queuedEnable = enable;
    return MH_OK;
}

MH_STATUS WINAPI MH_QueueEnableHook(LPVOID pTarget) { return Queue(pTarget, true); }
MH_STATUS WINAPI MH_QueueDisableHook(LPVOID pTarget) { return Queue(pTarget, false); }

MH_STATUS WINAPI MH_ApplyQueued(VOID) {
    ScopedSrwLock lk;
    if (!g_hHeap) return MH_ERROR_NOT_INITIALIZED;
    if (g_hookCount == 0) return MH_OK;

    size_t* toAttach = static_cast<size_t*>(HeapAlloc(g_hHeap, 0, g_hookCount * sizeof(size_t)));
    if (!toAttach) return MH_ERROR_MEMORY_ALLOC;

    size_t attachCount = 0;
    MH_STATUS status = MH_OK;
    for (size_t i = 0; i < g_hookCount; ++i) {
        HookEntry& h = g_hooks[i];
        if (!h.queuedValid) continue;
        h.queuedValid = false;
        if (h.enabled == h.queuedEnable) continue;

        if (!h.queuedEnable || h.attached) {
            SetGate(h, h.queuedEnable);
        } else if (!h.attachFailed) {
            toAttach[attachCount++] = i;
        } else {
            status = MH_ERROR_UNSUPPORTED_FUNCTION;
        }
    }

    if (attachCount > 0) {
        const MH_STATUS batchStatus = AttachAndEnableBatch(toAttach, attachCount);
        if (batchStatus != MH_OK) status = batchStatus;
    }
    HeapFree(g_hHeap, 0, toAttach);
    return status;
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
