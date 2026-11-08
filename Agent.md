# Agent.md — 自动发布指南（Open VSX）

> 面向 Claude / GPT / DeepSeek / GLM 等 AI 代理。
> 目标：在当前仓库完成版本发布，让 GitHub Actions 自动构建并上传 x64 VSIX 到 Open VSX。

## 0. 一句话流程

```text
push tag vX.Y.Z
  -> GitHub Actions: Release workflow
  -> 构建 x64 / x86 + 生成 GitHub Release 资产
  -> 同一次 workflow 的 publish-openvsx job
  -> npx ovsx publish（x64 VSIX）
  -> Open VSX 扫描后激活
```

## 1. 固定坐标

| 项目 | 值 |
|:--|:--|
| 仓库 | `https://github.com/yuaotian/antigravity-proxy` |
| 扩展 ID | `yuaotian.antigravity-proxy` |
| Open VSX 页面 | `https://open-vsx.org/extension/yuaotian/antigravity-proxy` |
| GitHub Secret | `OVSX_PAT`（受限发布 token） |
| 主工作流 | `.github/workflows/release.yml` |
| 手动兜底工作流 | `.github/workflows/publish-openvsx.yml` |
| 当前版本 | `2.6.3` |
| 下一个版本 | `2.6.4` |
| 已占用版本 | `2.6.0`、`2.6.2`（删除后不可复用） |

## 2. 标准发布流程（推荐）

### 2.1 前置检查

```powershell
git pull --ff-only origin main
git status --short          # 应为干净工作区
```

- 确认要发布的版本号**从未在 Open VSX 上使用过**；
- 确认 `OVSX_PAT` Secret 仍存在；
- 不要在仓库、脚本或提交中写入 token。

### 2.2 选择版本

- 当前 `build.ps1` 的 `$Version` 应为上一个已发布版本；
- 递增 patch：`2.6.3 -> 2.6.4`；
- Release workflow 会用 tag 自动覆盖 `build.ps1` 的 `$Version`，不需要手动改。

### 2.3 触发发布

```powershell
git tag -a v2.6.4 -m "Release v2.6.4"
git push origin v2.6.4
```

推送 tag 后不要再手动创建 GitHub Release；`release.yml` 会完成构建、打包和 Release。

### 2.4 观察 Actions

```powershell
gh run list --workflow release.yml --limit 3
```

或打开：

```text
https://github.com/yuaotian/antigravity-proxy/actions
```

必须确认 jobs：

- `Build x64 (IDE + CLI)`：success
- `Build x86 (IDE + CLI)`：success
- `Publish Release`：success
- `Publish Open VSX`：success

### 2.5 验证 Open VSX

```powershell
Invoke-WebRequest "https://open-vsx.org/api/yuaotian/antigravity-proxy/2.6.4"
Invoke-WebRequest "https://open-vsx.org/api/yuaotian/antigravity-proxy"
```

- 版本 API 返回 200，且 `version` 等于目标版本；
- 页面可打开；
- README 三张 raw 图片可加载。

Open VSX 有异步恶意包扫描；刚上传时可能暂时 404 或 inactive。**等待几分钟后重试**，不要立刻重复上传。

### 2.6 同步版本提交

Release workflow 成功后会把版本号同步回 `build.ps1` 并提交到 main：

```text
chore: 同步版本号到 vX.Y.Z [skip ci]
```

本地执行：

```powershell
git pull --ff-only origin main
```

## 3. 手动兜底

仅在 Actions 不可用或需要补发已有 tag 时使用。

### 3.1 手动触发 Release workflow

GitHub → Actions → `Release` → Run workflow，输入版本号 `2.6.4`。

### 3.2 手动触发 Publish Open VSX

适用于 GitHub Release 已经存在、但需要单独重推的情况：

GitHub → Actions → `Publish Open VSX` → Run workflow，输入已有 tag，例如 `v2.6.4`。

注意：由 `GITHUB_TOKEN` 创建的 Release 通常**不会**触发 `release: published` 工作流，所以主路径必须使用 `release.yml` 内嵌的 `publish-openvsx` job；`publish-openvsx.yml` 只是手动兜底。

### 3.3 本地应急发布

```powershell
.\build.ps1 -SkipTests -ExtensionVersion 2.6.4
# OVSX_PAT 由当前会话环境提供；不要把 token 写入文件或提交
npx --yes ovsx@latest publish output\ide\antigravity-proxy.vsix -p $env:OVSX_PAT
```

版本必须高于当前线上版本，且不能是已删除版本。

## 4. 绝对不要

- 不要复用已删除版本（`2.6.0`、`2.6.2` 已永久保留）；
- 不要 `unpublish` 后再用同一版本重发；
- 不要提交 `OVSX_PAT`、`ovsxat_...` token；
- 不要修改 `release.yml` 中的 `Publish Open VSX` job 为依赖 `release: published`；
- 不要手动编辑已构建 VSIX 后直接覆盖 Release 资产；
- 不要假设发布后 IDE 搜索立即出现（Open VSX 搜索索引有延迟）。

## 5. 常见故障

| 现象 | 处理 |
|:--|:--|
| `Extension ... already published but inactive` | 等待扫描；不要复用版本，必要时 bump patch 重新发布 |
| `Publish Open VSX` 失败：缺少 `OVSX_PAT` | 在 GitHub Settings → Secrets 添加受限 token |
| token invalid | 重新生成 `namespace=yuaotian`、`extension=antigravity-proxy`、Publishing only 的 token，更新 Secret |
| IDE 安装提示 `not found` | 搜索索引延迟；先从 Open VSX 页面下载 VSIX 安装 |
| 页面 README 图片不显示 | 检查三张 raw URL 是否 200；不要用 `blob` 链接 |
| 构建失败 | 查看 Actions 日志；确认 `build.ps1` 和 `scripts/package-release.ps1` 未被破坏 |

## 6. 关键文件

| 文件 | 作用 |
|:--|:--|
| `.github/workflows/release.yml` | tag 发布、构建、GitHub Release、内嵌 Open VSX 发布 |
| `.github/workflows/publish-openvsx.yml` | 已有 Release 的手动补发 |
| `build.ps1` | 版本、DLL/CLI 构建、VSIX 打包 |
| `scripts/package-release.ps1` | Release 资产命名与打包 |
| `resources/ide-extension/README.md` | Open VSX 市场详情页（三语 + raw 截图） |
| `docs/ide-extension.md` | 插件架构与行为说明 |

## 7. 一次性人工事项

- Open VSX 命名空间 `yuaotian` 的 **Claim Ownership** 需要人工提交 GitHub issue 并等待管理员审批；
- 在审批完成前，扩展页面会显示 `Unverified publisher`，但不影响发布和 VSIX 安装；
- 认领入口：`https://open-vsx.org/extension/yuaotian/antigravity-proxy` 页面里的 `Claim Ownership`。

## 8. 安装命令

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension yuaotian.antigravity-proxy
```

搜索不到时，下载当前版本 VSIX：

```text
https://open-vsx.org/api/yuaotian/antigravity-proxy/<version>/file/yuaotian.antigravity-proxy-<version>.vsix
```

在 Antigravity IDE 扩展视图右上角 `...` → `Install from VSIX`。

## 9. 当前状态

- 线上版本：`2.6.3`；
- Open VSX：x64 已发布，x86 只在 GitHub Release；
- 下一次自动发布：`v2.6.4`；
- 发布后检查页面：`https://open-vsx.org/extension/yuaotian/antigravity-proxy`。
