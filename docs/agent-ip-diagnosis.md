# Antigravity Agent 对话报错与代理出口 IP 排障说明

## 先说结论

当 Antigravity 对话时报：

```text
Agent execution terminated due to error.
Agent terminated due to error
```

不要先默认怀疑 `version.dll` 或 Hook 逻辑失效。

更常见、也更容易误判的真实场景是：
- DLL 已成功加载
- `Antigravity.exe` / `language_server_windows_x64.exe` / `node.exe` 已成功注入
- `oauth2.googleapis.com` / `daily-cloudcode-pa.googleapis.com` 仍然能通过代理正常连通
- 但 Antigravity 自己的 `ls-main.log` 返回：

```text
FAILED_PRECONDITION (code 400): User location is not supported for the API use.
```

这时主因通常已经不是 DLL，而是：

**Antigravity agent mode / Gemini CLI 对当前代理出口 IP 的 location / egress 策略不接受。**

## 为什么会误判成 DLL 问题

因为用户看到的是：
- 对话框报错
- 更新版本后才出现
- 更换了 DLL 或重新登录也可能没好

但真正关键的是：
- 基础授权、模型列表、配额查询这条路可以正常工作
- 失败的是 **agent execution** 这条更深的执行路径

也就是说：

**“普通请求能通” 和 “agent mode 真正可用” 不是一回事。**

## 现在版本新增了什么诊断能力

当前版本的 DLL 会在主 `Antigravity.exe` 进程里启动一次后台诊断，做两件事：

1. 通过当前配置的代理，探测实际出口 IP / 国家 / 组织信息
2. 扫描最新的 `%APPDATA%\\Antigravity\\logs\\<最新目录>\\ls-main.log`

如果同时命中下面两类证据：
- 当前出口 IP 呈现机房 / 托管 / 云服务特征
- 最新 `ls-main.log` 命中 `User location is not supported for the API use.`

DLL 会在 `proxy-YYYYMMDD.log` 里直接输出告警，提示：

- 当前失败更可能由出口 IP 导致
- 不是 DLL 注入失败
- 优先更换为普通 ISP / 住宅出口再试

如果拿不到 Antigravity 日志，DLL 也会退化成只输出 IP 风险提示。

## 重点看哪两份日志

### 1. DLL 日志

路径优先级：

1. `<Antigravity安装目录>\\logs\\proxy-YYYYMMDD.log`
2. `%TEMP%\\antigravity-proxy-logs\\proxy-YYYYMMDD.log`

如果下面这些关键行出现，说明 DLL 本身大概率已经工作正常：

- `[成功] 已注入新建进程: api=CreateProcessW, ..., target_basename=language_server_windows_x64.exe`
- `[成功] 已注入新建进程: api=CreateProcessW, ..., target_basename=node.exe`
- `SOCKS5: 隧道建立成功, 目标=oauth2.googleapis.com:443`
- `SOCKS5: 隧道建立成功, 目标=daily-cloudcode-pa.googleapis.com:443`

新增的诊断关键字：

- `[诊断/IP] 当前代理出口探测完成`
- `[诊断/IP] 当前代理出口呈现机房/托管特征`
- `[诊断/IP] 最新 Antigravity 日志已命中 location 限制错误，同时当前代理出口呈现机房/托管特征`

### 2. Antigravity 应用日志

重点看：

```text
%APPDATA%\Antigravity\logs\<最新时间目录>\ls-main.log
```

最关键的失败标志：

```text
agent executor error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.
```

如果你看到了这一行，就说明：

- agent 真正开始执行了
- 失败发生在服务端/策略层
- 此时优先排出口 IP，而不是继续折腾 DLL

## 推荐排查顺序

### 场景 A：DLL 日志里已经看到注入成功 + SOCKS5 成功

这时直接去看 `ls-main.log`：

- 如果有 `User location is not supported for the API use.`
  - 优先换 IP
  - 尤其优先从机房 / VPS / 托管出口切到普通 ISP / 住宅出口

### 场景 B：DLL 新增诊断直接提示机房/托管特征

这时建议：

1. 先不要继续改 DLL
2. 直接更换出口 IP / ASN
3. 保持国家支持区域不变（例如继续用 SG），只换不同类型的出口

### 场景 C：DLL 日志里连注入和代理握手都没有成功

这时才回头排 DLL：

- `version.dll` 是否放在正确目录
- `config.json` 是否被成功读取
- `proxy.host/proxy.port/proxy.type` 是否正确
- `target_processes` / `child_injection_mode` 是否覆盖到了真实链路

## 一个容易忽略的事实

**国家代码支持，不代表当前出口一定被 agent mode 接受。**

例如：
- 两个都显示为 `SG`
- 但一个是普通 ISP 出口，一个是机房 / 托管网络出口
- 对 Antigravity agent mode 来说，结果可能不同

所以看地区时，不要只看 `country=SG`，还要看：
- ASN / 组织名
- 是否机房 / VPS / 托管网络

## 推荐处理策略

优先级从高到低：

1. 先换一个非机房的新加坡出口重试
2. 再考虑切换到官方更稳的环境（如 Cloud Shell / 官方支持的 Gemini Code Assist 路径）
3. 最后才回头继续改 DLL

## 一句话总结

> Antigravity 对话报错时，如果 `proxy.log` 证明注入和代理都成功，而 `ls-main.log` 返回 `User location is not supported for the API use.`，那就先排出口 IP，不要先怀疑 DLL。
