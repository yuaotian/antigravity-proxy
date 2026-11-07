# Antigravity-Proxy 可视化配置工具（Config Web）

## 文件位置与构建产物

- **源码（开发态）**：`resources/config-web/index.html`
- **构建输出（用户可直接打开）**：`output/config-web.html`
  - 由 `build.ps1` 在生成 `使用说明.md` 后复制得到（Step 10）
- **Release 资产**：`scripts/package-release.ps1` 会把 `config-web.html` 分别放入 IDE 与 CLI 独立压缩包
  - `.github/workflows/release.yml` 每个架构只编译一次，再调用统一脚本生成两套互不混装的资产

## 使用方式（无需服务端）

1. 直接用浏览器打开：
   - 仓库内：`resources/config-web/index.html`
   - 或构建后：`output/config-web.html`
2. **导入**：拖拽或点击「导入」选择 `config.json`
3. **编辑**：按左侧导航分组修改字段（支持数组增删与拖拽排序）
4. **导出**：点击「导出」生成新的 `config.json`

> 安全说明：全程仅在浏览器本地处理文件，不进行网络上传。

## 配置结构覆盖范围（与后端解析一致）

本工具覆盖后端实际读取的全部配置字段（见 `src/core/Config.hpp` 中 `Core::Config::Load()`），并额外包含 `build.ps1` 生成的元信息字段 `_comment/_version/_build`。

### 顶层字段

- **元信息（导出时写入）**
  - `_comment`：说明字符串（`build.ps1` 会写入默认值，见 `build.ps1` L246-L253）
  - `_version`：版本号（来自 `build.ps1` 的 `$Version`）
  - `_build`：`{ date, config, arch }`（构建/导出时间与构建参数）
- **核心配置**
  - `log_level`：`debug/info/warn/error`
  - `proxy`：`{ host, port, type, username, password }`
  - `fake_ip`：`{ enabled, cidr }`
  - `timeout`：`{ connect, send, recv }`（毫秒）
  - `traffic_logging`：布尔
  - `diagnostics`：`{ agent_ip_probe }`（默认关闭的出口 IP/location 联合诊断）
  - `child_injection`：布尔
  - `child_injection_mode`：`filtered/inherit`
  - `child_injection_exclude`：字符串数组
  - `target_processes`：字符串数组
  - `proxy_rules`：
    - `allowed_ports`：端口白名单数组（空数组=全部端口）
    - `dns_mode`：`direct/proxy`
    - `ipv6_mode`：`proxy/direct/block`
    - `udp_mode`：`auto/block/direct/proxy`
    - `udp_fallback`：`block/direct`（`udp_mode=auto/proxy` 时生效）
    - `routing`：
      - `enabled`
      - `priority_mode`：`order/number`
      - `default_action`：`proxy/direct`
      - `use_default_private`
      - `rules`：RoutingRule 数组

### RoutingRule（`proxy_rules.routing.rules[]`）

- `name`：规则名
- `enabled`：是否启用
- `action`：`proxy/direct`
- `priority`：优先级（仅 `priority_mode=number` 时生效）
- `ip_cidrs_v4`：IPv4 CIDR 字符串数组
- `ip_cidrs_v6`：IPv6 CIDR 字符串数组
- `domains`：域名模式数组（支持通配符、`.example.com` 语义）
- `ports`：端口/端口范围字符串数组（如 `443` / `10000-20000`）
- `protocols`：协议数组（当前主要使用 `tcp`）

## 导入/导出行为

- **导入**：读取 JSON → 归一化（枚举小写、缺省字段补齐、数值范围防御性回退）
  - 对应实现：`resources/config-web/index.html` 中 `normalizeForm()`
- **导出**：以导入的原始 JSON 为底（保留未知字段），再“对象级覆盖”已知字段，最后 `JSON.stringify(..., null, 2)` 导出
  - 对应实现：`exportObject()`

## 实时校验规则（前端）

校验集中在 `validateAll()`，重点包括：

- **端口**：
  - `proxy.port`：允许 `0-65535`，其中 `0` 表示禁用代理（后端确有该语义）
  - `proxy_rules.allowed_ports[]`：必须为 `1-65535` 且不能为 `0`
  - `RoutingRule.ports[]`：支持 `80` 或 `10000-20000`，且端口必须 `1-65535`
- **CIDR**：
  - `fake_ip.cidr`：要求 IPv4 CIDR
  - `RoutingRule.ip_cidrs_v4/ip_cidrs_v6`：分别校验 v4/v6 CIDR
- **枚举值**：`log_level`、`proxy.type`、`child_injection_mode`、`dns_mode/ipv6_mode/udp_mode/udp_fallback`、`priority_mode/default_action` 等

## 构建/发布集成说明

- `build.ps1`：Step 10 复制配置工具到 `output/config-web.html`
- `release.yml`：在打包前兜底复制并在缺失时失败

## 已知限制/注意事项

- **联网依赖**：Tailwind 与 Font Awesome 通过 CDN 加载；离线环境下 UI 可能无样式/无图标。
- **剪贴板**：`file://` 场景下浏览器可能限制 `navigator.clipboard`，复制按钮失败会提示。

## 维护建议（当 Config.hpp 变更时）

当 `src/core/Config.hpp` 新增/调整字段时，优先同步以下 3 处以避免遗漏：

1. `defaultForm()`：新增字段默认值
2. `normalizeForm()`：导入归一化策略（小写/回退/类型修正）
3. `validateAll()`：新增字段校验与错误提示

> 说明：当前未引入独立“自动漂移检测脚本”；已在页面内置字段漂移自检提示机制，但仍建议将上述三处作为 PR Checklist 必检项。

## 字段同步方案（新增）

- 详细方案见：`docs/config-web-sync-strategy.md`
- 该文档补充了前端内置“字段漂移自检提示”机制与维护清单，建议与本文件配合使用。

