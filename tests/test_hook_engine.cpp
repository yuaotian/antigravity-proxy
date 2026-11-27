// Hook 引擎单元测试（覆盖 x86/x64 MinHook 与 ARM64 Detours 兼容层）：
// 1. MH_CreateHook 后、MH_EnableHook 前 *ppOriginal 立即可调用且目标函数尚未生效；
// 2. MH_EnableHook(MH_ALL_HOOKS) / MH_DisableHook / MH_Queue* / MH_ApplyQueued / MH_RemoveHook 状态机；
// 3. 多线程持续争抢进程默认堆（GetProcessHeap）锁并发压测，验证挂起其它线程安装/卸载 Hook 时不死锁。

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <MinHook.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

namespace {

volatile int g_volatileGuard = 0;

#pragma optimize("", off)
__declspec(noinline) int WINAPI TargetFn0(int a, int b) {
    int v = a + b + 101 + g_volatileGuard;
    return v - 101;
}

__declspec(noinline) int WINAPI TargetFn1(int a, int b) {
    int v = (a * 3) + b + 202 + g_volatileGuard;
    return v - 202;
}

__declspec(noinline) int WINAPI TargetFn2(int a, int b) {
    int v = (a ^ b) + 303 + g_volatileGuard;
    return v - 303;
}

__declspec(noinline) int WINAPI TargetFn3(int a, int b) {
    int v = (a - b) + 404 + g_volatileGuard;
    return v - 404;
}
#pragma optimize("", on)

using Fn_t = int(WINAPI*)(int, int);

Fn_t g_orig0 = nullptr;
Fn_t g_orig1 = nullptr;
Fn_t g_orig2 = nullptr;
Fn_t g_orig3 = nullptr;

int WINAPI DetourFn0(int a, int b) { return g_orig0(a, b) + 1000; }
int WINAPI DetourFn1(int a, int b) { return g_orig1(a, b) + 2000; }
int WINAPI DetourFn2(int a, int b) { return g_orig2(a, b) + 3000; }
int WINAPI DetourFn3(int a, int b) { return g_orig3(a, b) + 4000; }

#define CHECK_TRUE(cond, msg)                                                       \
    do {                                                                            \
        if (!(cond)) {                                                              \
            std::fprintf(stderr, "[FAIL] %s (line %d)\n", (msg), __LINE__);         \
            return false;                                                           \
        }                                                                           \
    } while (0)

#define CHECK_STATUS(actual, expected, msg)                                         \
    do {                                                                            \
        const MH_STATUS st_ = (actual);                                             \
        if (st_ != (expected)) {                                                    \
            std::fprintf(stderr, "[FAIL] %s: got %s (%d), expected %s (%d)\n",      \
                         (msg), MH_StatusToString(st_), static_cast<int>(st_),      \
                         MH_StatusToString(expected), static_cast<int>(expected));  \
            return false;                                                           \
        }                                                                           \
    } while (0)

bool TestLifecycleAndBatchSemantics() {
    volatile Fn_t call0 = &TargetFn0;
    volatile Fn_t call1 = &TargetFn1;
    volatile Fn_t call2 = &TargetFn2;

    CHECK_STATUS(MH_Initialize(), MH_OK, "MH_Initialize");
    CHECK_STATUS(MH_Initialize(), MH_ERROR_ALREADY_INITIALIZED, "duplicate MH_Initialize");

    CHECK_STATUS(MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn0),
                               reinterpret_cast<LPVOID>(&DetourFn0),
                               reinterpret_cast<LPVOID*>(&g_orig0)),
                 MH_OK, "MH_CreateHook Fn0");
    CHECK_STATUS(MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn0),
                               reinterpret_cast<LPVOID>(&DetourFn0),
                               reinterpret_cast<LPVOID*>(&g_orig0)),
                 MH_ERROR_ALREADY_CREATED, "duplicate MH_CreateHook Fn0");

    CHECK_STATUS(MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn1),
                               reinterpret_cast<LPVOID>(&DetourFn1),
                               reinterpret_cast<LPVOID*>(&g_orig1)),
                 MH_OK, "MH_CreateHook Fn1");
    CHECK_STATUS(MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn2),
                               reinterpret_cast<LPVOID>(&DetourFn2),
                               reinterpret_cast<LPVOID*>(&g_orig2)),
                 MH_OK, "MH_CreateHook Fn2");

    // 关键语义：启用前目标函数仍走原逻辑，且 *ppOriginal 已经可以安全调用
    CHECK_TRUE(g_orig0 != nullptr && g_orig1 != nullptr && g_orig2 != nullptr, "ppOriginal non-null");
    CHECK_TRUE(call0(4, 5) == 9, "TargetFn0 unhooked before enable");
    CHECK_TRUE(g_orig0(4, 5) == 9, "g_orig0 callable before enable");
    CHECK_TRUE(g_orig1(4, 5) == 17, "g_orig1 callable before enable");

    // 批量启用全部 Hook
    CHECK_STATUS(MH_EnableHook(MH_ALL_HOOKS), MH_OK, "MH_EnableHook(MH_ALL_HOOKS)");
    CHECK_TRUE(call0(4, 5) == 1009, "TargetFn0 hooked after batch enable");
    CHECK_TRUE(call1(4, 5) == 2017, "TargetFn1 hooked after batch enable");
    CHECK_TRUE(call2(6, 3) == (6 ^ 3) + 3000, "TargetFn2 hooked after batch enable");
    CHECK_STATUS(MH_EnableHook(reinterpret_cast<LPVOID>(&TargetFn0)),
                 MH_ERROR_ENABLED, "duplicate enable Fn0");

    // 单个禁用 + 队列批量切换
    CHECK_STATUS(MH_DisableHook(reinterpret_cast<LPVOID>(&TargetFn1)), MH_OK, "disable Fn1");
    CHECK_TRUE(call1(4, 5) == 17, "TargetFn1 restored after disable");
    CHECK_STATUS(MH_DisableHook(reinterpret_cast<LPVOID>(&TargetFn1)),
                 MH_ERROR_DISABLED, "duplicate disable Fn1");

    CHECK_STATUS(MH_QueueDisableHook(reinterpret_cast<LPVOID>(&TargetFn0)), MH_OK, "queue disable Fn0");
    CHECK_STATUS(MH_QueueEnableHook(reinterpret_cast<LPVOID>(&TargetFn1)), MH_OK, "queue enable Fn1");
    CHECK_STATUS(MH_ApplyQueued(), MH_OK, "MH_ApplyQueued");
    CHECK_TRUE(call0(4, 5) == 9, "TargetFn0 disabled via queue");
    CHECK_TRUE(call1(4, 5) == 2017, "TargetFn1 enabled via queue");

    // 移除单个 Hook
    CHECK_STATUS(MH_RemoveHook(reinterpret_cast<LPVOID>(&TargetFn2)), MH_OK, "remove Fn2");
    CHECK_TRUE(call2(6, 3) == (6 ^ 3), "TargetFn2 restored after remove");
    CHECK_STATUS(MH_RemoveHook(reinterpret_cast<LPVOID>(&TargetFn2)),
                 MH_ERROR_NOT_CREATED, "duplicate remove Fn2");

    CHECK_STATUS(MH_Uninitialize(), MH_OK, "MH_Uninitialize");
    CHECK_TRUE(call0(4, 5) == 9, "TargetFn0 restored after uninit");
    CHECK_TRUE(call1(4, 5) == 17, "TargetFn1 restored after uninit");
    return true;
}

bool TestConcurrentProcessHeapContention() {
    std::atomic<bool> stop{false};
    std::atomic<bool> badResult{false};
    volatile Fn_t call0 = &TargetFn0;
    volatile Fn_t call3 = &TargetFn3;

    CHECK_STATUS(MH_Initialize(), MH_OK, "stress MH_Initialize");
    CHECK_STATUS(MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn0),
                               reinterpret_cast<LPVOID>(&DetourFn0),
                               reinterpret_cast<LPVOID*>(&g_orig0)),
                 MH_OK, "stress MH_CreateHook Fn0");
    CHECK_STATUS(MH_EnableHook(reinterpret_cast<LPVOID>(&TargetFn0)),
                 MH_OK, "stress MH_EnableHook Fn0");

    // 启动多个工作线程高频在默认进程堆（GetProcessHeap）上分配/释放并并发调用已挂载的目标函数，
    // 复现“被挂起线程恰好持有进程堆锁”的竞争窗口。
    // 注意：不在工作线程并发进入 Detour 期间调用 MH_Uninitialize（x86/x64 原生 MinHook 的
    // UninitializeBuffer 会 VirtualFree trampoline 页，若有线程刚进入 Detour 尚未跳入 g_orig 会触发 UAF）。
    constexpr int kWorkerCount = 6;
    std::vector<std::thread> workers;
    workers.reserve(kWorkerCount);
    for (int w = 0; w < kWorkerCount; ++w) {
        workers.emplace_back([&]() {
            HANDLE procHeap = GetProcessHeap();
            while (!stop.load(std::memory_order_relaxed)) {
                for (int i = 0; i < 32; ++i) {
                    void* p1 = HeapAlloc(procHeap, 0, 64 + (i * 16));
                    void* p2 = std::malloc(128);
                    const int r = call0(10, 3);
                    if (r != 13 && r != 1013) {
                        badResult.store(true, std::memory_order_relaxed);
                    }
                    if (p2) std::free(p2);
                    if (p1) HeapFree(procHeap, 0, p1);
                }
            }
        });
    }

    bool ok = true;
    for (int round = 0; round < 20; ++round) {
        if (MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn1),
                          reinterpret_cast<LPVOID>(&DetourFn1),
                          reinterpret_cast<LPVOID*>(&g_orig1)) != MH_OK ||
            MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn2),
                          reinterpret_cast<LPVOID>(&DetourFn2),
                          reinterpret_cast<LPVOID*>(&g_orig2)) != MH_OK ||
            MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn3),
                          reinterpret_cast<LPVOID>(&DetourFn3),
                          reinterpret_cast<LPVOID*>(&g_orig3)) != MH_OK ||
            MH_EnableHook(MH_ALL_HOOKS) != MH_OK ||
            call3(10, 3) != 4007 ||
            MH_DisableHook(reinterpret_cast<LPVOID>(&TargetFn0)) != MH_OK ||
            MH_QueueEnableHook(reinterpret_cast<LPVOID>(&TargetFn0)) != MH_OK ||
            MH_ApplyQueued() != MH_OK ||
            MH_RemoveHook(reinterpret_cast<LPVOID>(&TargetFn1)) != MH_OK ||
            MH_RemoveHook(reinterpret_cast<LPVOID>(&TargetFn2)) != MH_OK ||
            MH_RemoveHook(reinterpret_cast<LPVOID>(&TargetFn3)) != MH_OK) {
            ok = false;
            break;
        }
    }

    stop.store(true, std::memory_order_relaxed);
    for (auto& t : workers) {
        t.join();
    }

    CHECK_STATUS(MH_Uninitialize(), MH_OK, "stress MH_Uninitialize");
    CHECK_TRUE(ok, "20 rounds of concurrent hook install/remove under heap contention");
    CHECK_TRUE(!badResult.load(), "concurrent target calls observed only valid pre/post values");
    return true;
}

bool TestShortLivedThreadChurn() {
    std::atomic<bool> stop{false};
    volatile Fn_t call0 = &TargetFn0;

    CHECK_STATUS(MH_Initialize(), MH_OK, "churn MH_Initialize");

    // 持续制造高频创建并立刻退出的短命线程，验证 CollectAndSuspendOtherThreads 不会因
    // 挂起已退出线程而毒化整笔 Detours 事务。
    std::thread spawner([&]() {
        while (!stop.load(std::memory_order_relaxed)) {
            std::thread burst[4];
            for (int i = 0; i < 4; ++i) {
                burst[i] = std::thread([]() {});
            }
            for (int i = 0; i < 4; ++i) {
                burst[i].join();
            }
        }
    });

    bool ok = true;
    for (int round = 0; round < 15; ++round) {
        if (MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn0),
                          reinterpret_cast<LPVOID>(&DetourFn0),
                          reinterpret_cast<LPVOID*>(&g_orig0)) != MH_OK ||
            MH_CreateHook(reinterpret_cast<LPVOID>(&TargetFn1),
                          reinterpret_cast<LPVOID>(&DetourFn1),
                          reinterpret_cast<LPVOID*>(&g_orig1)) != MH_OK ||
            MH_EnableHook(MH_ALL_HOOKS) != MH_OK ||
            call0(2, 3) != 1005 ||
            MH_RemoveHook(reinterpret_cast<LPVOID>(&TargetFn1)) != MH_OK ||
            MH_RemoveHook(reinterpret_cast<LPVOID>(&TargetFn0)) != MH_OK) {
            ok = false;
            break;
        }
    }

    stop.store(true, std::memory_order_relaxed);
    spawner.join();
    CHECK_STATUS(MH_Uninitialize(), MH_OK, "churn MH_Uninitialize");
    CHECK_TRUE(ok, "15 rounds under short-lived thread churn");
    return true;
}

}  // namespace

int main() {
    if (!TestLifecycleAndBatchSemantics()) return 1;
    if (!TestConcurrentProcessHeapContention()) return 1;
    if (!TestShortLivedThreadChurn()) return 1;
    std::printf("[PASS] hook_engine_tests all passed.\n");
    return 0;
}
