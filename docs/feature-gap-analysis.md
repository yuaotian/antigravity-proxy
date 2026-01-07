# Feature Gap Analysis: Antigravity-Proxy vs Original DLL

## 分析日期
2026-01-07

## 分析目标
对比原版 DLL 伪代码 (`BinaryNinja.txt`, `Hex-Rays.txt`) 与当前 `antigravity-proxy` 实现。

---

## 功能对比矩阵

| 功能模块 | 原版 DLL | 实现状态 |
|----------|----------|----------|
| DLL 代理 (version.dll) | ✅ | ✅ Phase 1 |
| 配置文件解析 | ✅ INI | ✅ JSON (升级) |
| connect() Hook | ✅ | ✅ Phase 1 |
| WSAConnect() Hook | ✅ | ✅ Phase 1 |
| getaddrinfo() Hook | ✅ | ✅ Phase 1 |
| FakeIP 系统 | ✅ | ✅ Phase 1 |
| SOCKS5 协议 | ✅ | ✅ Phase 1 (基础级) |
| CreateProcessW Hook | ✅ | ⏳ Phase 2 |
| 子进程自动注入 | ✅ | ⏳ Phase 2 |
| send/recv Hook | ✅ | ⏳ Phase 3 |
| TargetProcess 过滤 | ✅ | ⏳ 待定 |
| DnsServer 配置 | ✅ | ⏳ 待定 |
| 超时控制 | ❌ | ✅ 新增 |

---

## 技术决策记录

### 1. DLL 代理方式
**决策**: 静态导出转发 (DEF 文件)
**理由**: 简单可靠，性能好，无需运行时动态解析

### 2. SOCKS5 协议级别
**决策**: 基础级 (无认证 + TCP CONNECT)
**理由**: 覆盖 90% 使用场景，避免过度设计

### 3. 配置格式
**决策**: JSON 替代 INI
**理由**: 更现代，结构化更强，易于扩展

---

## Phase 1 实现清单 (已完成)
- [x] version.dll 代理框架
- [x] 完整 FakeIP 系统
- [x] SOCKS5 基础协议
- [x] WSAConnect Hook

## Phase 2 待实现
- [ ] CreateProcessW Hook
- [ ] 子进程自动注入

## Phase 3 待实现
- [ ] send/recv Hook
- [ ] 流量监控/修改
