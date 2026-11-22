# Microsoft Detours (Vendored for Windows on ARM64)

本目录收录 [microsoft/Detours](https://github.com/microsoft/Detours) 的最小源码子集，仅在 Windows on ARM64（`AGP_ARM64=ON`）构建时编译，配合 `src/hooks/ArmHook.cpp` 提供与 MinHook 一致的 API 兼容层（x86 / x64 构建仍使用原有的 MinHook，不编译本目录任何文件）。

## 上游来源

- **上游仓库**：`https://github.com/microsoft/Detours`
- **对应 Commit**：`1dbd4ea281d73d478aa8d09a8b83fbd265f715f7`（`main` 分支，2026-09-29，基于 Detours 4.0.1 并包含后续 ARM64 / ARM64EC 修复）
- **许可证**：MIT（见同目录 [LICENSE.md](LICENSE.md)）

## 文件清单与改动说明

| 本地文件 | 上游路径 | 是否改动 |
|:--|:--|:--|
| `LICENSE.md` | `LICENSE.md` | 未改动 |
| `detours.h` | `src/detours.h` | 未改动 |
| `detver.h` | `src/detver.h` | 未改动 |
| `disasm.cpp` | `src/disasm.cpp` | 未改动（仅 Git 统一 LF 换行符） |
| `disolarm64.cpp` | `src/disolarm64.cpp` | 未改动 |
| `image.cpp` | `src/image.cpp` | 未改动（仅 Git 统一 LF 换行符） |
| `modules.cpp` | `src/modules.cpp` | 未改动 |
| `detours.cpp` | `src/detours.cpp` | **1 处最小改动**（见下） |

### `detours.cpp` 本地改动说明

上游 `DetourUpdateThread`、`DetourAttachEx`、`DetourDetach` 及 `DetourTransactionCommitEx` 在管理挂起线程链表（`struct DetourThread`）与待提交操作链表（`struct DetourOperation`）时使用全局 `new` / `delete`（走进程默认堆 `GetProcessHeap()`）。当其它线程已被 `SuspendThread` 挂起且恰好持有默认进程堆锁时，继续在默认堆上分配或释放节点会导致启动死锁。

本地仅对上述两个内部结构体增加了基于独立私有堆（`HeapCreate(0, 0, 0)`，在 `DetourTransactionBegin` 挂起任何线程前完成初始化）的 `operator new` / `operator delete` 重载，其余反汇编、trampoline 生成与线程上下文重定位逻辑均与上游完全一致。升级上游版本时只需保留 `Transaction Structs` 与 `DetourTransactionBegin` 处的私有堆分配块即可。
