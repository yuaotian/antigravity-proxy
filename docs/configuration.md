# 配置参考（config.json）

> 内容自 README 迁移。日常修改推荐用 IDE 插件的设置面板，或发布包里的 `config-web.html`（导入 / 编辑 / 导出）。
> DLL 只在进程启动时读取 `config.json`，修改后需重启对应应用。

## 配置示例

```json
{
    "proxy": {
        "host": "127.0.0.1",
        "port": 7890,
        "type": "socks5"
    },
    "fake_ip": {
        "enabled": true,
        "cidr": "198.18.0.0/15"
    },
    "timeout": {
        "connect": 5000,
        "send": 5000,
        "recv": 5000
    },
    "child_injection": true,
    "child_injection_mode": "filtered",
    "target_processes": [
        "agy.exe",
        "language_server.exe",
        "language_server_windows",
        "Antigravity.exe",
        "Antigravity IDE.exe",
        "node.exe"
    ],
    "proxy_rules": {
        "allowed_ports": [80, 443],
        "dns_mode": "direct",
        "ipv6_mode": "proxy"
    }
}
```

### 配置文件详解 / Configuration Reference

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `proxy.host` | string | `"127.0.0.1"` | 代理服务器地址 |
| `proxy.port` | int | `7890` | 代理服务器端口 |
| `proxy.type` | string | `"socks5"` | 代理类型: `socks5` 或 `http`（兼容 `https`，按 `http` 处理） |
| `proxy.username` | string | `""` | 代理认证用户名（可选，支持 HTTP Basic 与 SOCKS5 RFC 1929 认证） |
| `proxy.password` | string | `""` | 代理认证密码（可选） |
| `fake_ip.enabled` | bool | `true` | 是否启用 FakeIP 系统 |
| `fake_ip.cidr` | string | `"198.18.0.0/15"` | FakeIP 地址范围 (基准测试保留网段) |
| `timeout.connect` | int | `5000` | 连接超时 (毫秒) |
| `timeout.send` | int | `5000` | 发送超时 (毫秒) |
| `timeout.recv` | int | `5000` | 接收超时 (毫秒) |
| `child_injection` | bool | `true` | 是否注入子进程 |
| `traffic_logging` | bool | `false` | 是否记录流量日志 |
| `diagnostics.agent_ip_probe` | bool | `false` | 是否探测代理出口 IP 并关联 location 日志 |
| `target_processes` | array | `[]` | 目标进程列表 (空=全部) |
| `proxy_rules.allowed_ports` | array | `[80, 443]` | 端口白名单 (空=全部) |
| `proxy_rules.dns_mode` | string | `"direct"` | DNS策略: `direct`(直连) / `proxy`(走代理) |
| `proxy_rules.ipv6_mode` | string | `"proxy"` | IPv6策略: `proxy`(走代理) / `direct`(直连) / `block`(阻止) |
| `proxy_rules.udp_mode` | string | `"auto"` | UDP策略: `auto`(SOCKS5 自动代理) / `block` / `direct` / `proxy` |
| `proxy_rules.udp_fallback` | string | `"block"` | UDP 代理失败或 auto 遇到非 SOCKS5 代理时: `block` / `direct` |
| `proxy_rules.routing.enabled` | bool | `true` | 是否启用规则路由 |
| `proxy_rules.routing.priority_mode` | string | `"order"` | 规则优先级: `order`(按顺序) / `number`(priority) |
| `proxy_rules.routing.default_action` | string | `"proxy"` | 未命中时默认动作 |
| `proxy_rules.routing.use_default_private` | bool | `true` | 自动加载 RFC1918/loopback 内网直连规则 |
| `proxy_rules.routing.rules` | array | `[]` | 规则列表（支持 CIDR/域名通配符/端口/协议） |

### 规则路由 / Routing Rules

路由规则由 `proxy_rules.routing` 管理，支持 CIDR/域名通配符/端口/协议分流，优先级可选 `order`(按顺序) 或 `number`(priority)。

```json
{
  "proxy_rules": {
    "routing": {
      "enabled": true,
      "priority_mode": "order",
      "default_action": "proxy",
      "use_default_private": true,
      "rules": [
        {
          "name": "lan-direct",
          "action": "direct",
          "ip_cidrs_v4": ["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],
          "ip_cidrs_v6": ["fc00::/7","fe80::/10","::1/128"],
          "domains": [".local","*.corp.example.com"],
          "protocols": ["tcp"]
        }
      ]
    }
  }
}
```

**可视化配置工具**：`resources/config-web/index.html`（本地打开即可使用；或构建后使用 `output/config-web.html`，支持导入/编辑/导出 `config.json`）。

**说明**：`AUTHORS.txt` 为内嵌的 MinHook 依赖作者名单，并非本项目维护者列表。

**提示**：
- 端口留空代表“全部端口”；域名留空仅按 CIDR 匹配；域名填 `*` 将匹配所有域名。
- 全量匹配可用 `0.0.0.0/0` 与 `::/0`。
- 工具已支持 `proxy.host` / `proxy.port` / `proxy.type` / `proxy.username` / `proxy.password` 的编辑。

### 已知问题 / Known Issues

- **历史版本（已修复）：FakeIP 与 `direct + domains + ports`**：在部分旧版本中，若启用 FakeIP，且 `action=direct` 的规则同时配置了 `domains` 与 `ports`，可能出现 DNS 阶段分配 FakeIP，随后 connect 阶段“直连虚拟地址”导致连接失败。若你仍在使用旧版本，建议升级；或临时规避：移除该规则的 `ports` 条件，或关闭 FakeIP。

### IPv6 注意事项

当日志出现 `SOCKS5: 读取认证响应失败, WSA错误码=10060`，且目标是 IPv6 地址（如 `2001:4860:4860::8888:443`），表示代理没有及时响应该 IPv6 连接。

当前版本会在 IPv6 socket 创建且尚未 bind 时自动关闭 `IPV6_V6ONLY`，使 `127.0.0.1` 这类 IPv4 代理可通过 v4-mapped IPv6 地址连接。若应用之后重新启用 v6-only，日志会输出具体 WSA 错误码。

可选处理方式：
- **快速止血**：将 `proxy_rules.ipv6_mode` 改为 `block`（阻止）或 `direct`（直连）。
- **原生 IPv6 代理**：让代理监听 `::1`，再把 `proxy.host` 改为 `::1`。

**优先级说明**：当目标为纯 IPv6（非 v4-mapped）且 `proxy_rules.ipv6_mode` 为 `direct`/`block` 时，会在进入 `routing` 规则前直接直连/阻止；当 `ipv6_mode=proxy` 时才会继续进入 `routing` 匹配。

### UDP/QUIC 注意事项

当目标程序使用 **QUIC/HTTP3**（UDP/443）时，默认 `udp_mode=auto` 会在 SOCKS5 下自动使用 UDP Associate。

推荐配置：
- 保持 `proxy_rules.udp_mode=auto`
- 将 `proxy.type` 设为 `socks5`（HTTP 代理没有标准 UDP 转发能力）
- 确保代理软件**支持 SOCKS5 UDP Associate** 并允许 UDP 转发（不同客户端/内核能力不同）
- 可选：当代理不支持 UDP 时，可将 `proxy_rules.udp_fallback` 设为 `direct`（⚠️ 可能导致 UDP 直连泄漏；默认 `block` 更安全）

示例：

```json
{
  "proxy": { "host": "127.0.0.1", "port": 10808, "type": "socks5" },
  "proxy_rules": {
    "udp_mode": "auto",
    "dns_mode": "direct",
    "allowed_ports": [80, 443]
  }
}
```

说明：
- `dns_mode="direct"` 仍会放行 UDP/53（避免 DNS 超时）；若你希望 DNS 也走代理，请改为 `dns_mode="proxy"`。
- `auto + socks5` 的有效策略为 proxy；`auto + http` 按 `udp_fallback` 决定 block/direct。
- 显式 `udp_mode=block` 会阻断大部分 UDP，但仍放行 loopback 与 UDP/53。

## 进阶：强制代理其他程序

本项目首先为 Antigravity 服务，但底层是通用的进程级强制代理，也可以用于其他不走系统代理的 Windows 程序。

### 示例 1: 强制代理 Chrome

```json
{
    "proxy": {
        "host": "127.0.0.1",
        "port": 7890,
        "type": "socks5"
    },
    "child_injection": true,
    "target_processes": []
}
```

然后将 `version.dll` 和 `config.json` 复制到 Chrome 安装目录：

```
C:\Program Files\Google\Chrome\Application\
├── chrome.exe
├── version.dll      ← 放这里
└── config.json      ← 放这里
```

### 示例 2: 强制代理 VS Code

```
C:\Users\你的用户名\AppData\Local\Programs\Microsoft VS Code\
├── Code.exe
├── version.dll      ← 放这里
└── config.json      ← 放这里
```

### 示例 3: 仅代理特定子进程

如果你只想代理程序的某些子进程，可以使用 `target_processes` 配置：

```json
{
    "target_processes": [
        "node.exe",
        "npm.cmd",
        "language_server.exe"
    ]
}
```
