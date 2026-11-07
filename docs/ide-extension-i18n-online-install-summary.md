# 本轮总结：插件三语 + 首次引导扫描 + DLL 安装提示 + 在线安装 + README 精简

> 分支：`feat/ide-config-extension`（2026-11-07）。技术细节见 [ide-extension.md](ide-extension.md)、[doctor.md](doctor.md)。

## 1. 需求与方案

| # | 需求 | 方案 |
|:--|:--|:--|
| 1 | 插件支持中英俄三语 | 运行时 `media/i18n.js` + 原生 `package.nls*.json`；默认跟随 IDE 语言，`antigravityProxy.language` 可覆盖 |
| 2 | 编译 DLL 时打包插件并放进 Release 资源 | VSIX 输出到 `output/ide/`（随 DLL 部署）+ 独立 Release 资产 + `SHA256SUMS.txt` |
| 3 | 检测插件未安装时提示，用 VS Code 机制安装 | DLL 在 IDE 主进程检测并询问，调用 `antigravity-ide.cmd --install-extension`；实测无需重启 |
| 4 | 首次打开未设置代理时自动跳转并扫描本机代理 | 首次引导：可用只通知；不可用则打开面板扫描，单个自动填入、多个选择、无结果呼吸描边提示手动填写 |
| 5 | 启动器支持 Antigravity IDE | `AntigravityLauncher.cpp` / `install-windows.ps1` 识别 `Antigravity IDE.exe` |
| 6 | Windows 在线安装脚本（镜像） | `scripts/install-online.ps1`：经 wget.la 获取，检测三种产品，镜像下载 + 校验（不阻断）+ doctor 部署 |
| 7 | 精简 README | 三语 README 1314 → 245 行，技术细节迁入 `docs/` |

## 2. 改动清单

| 提交 | 主要文件 |
|:--|:--|
| `feat(ide-extension)` 三语 + 首次引导扫描 | `resources/ide-extension/{extension.js, lib/*.js, media/i18n.js, media/panel.*, package*.json}`、`resources/shared/config-core.js`（`validateForm(form, lang)`） |
| `build(ci)` VSIX 打包与发布 | `build.ps1`、`scripts/package-release.ps1`、`.github/workflows/{build,release}.yml`、`scripts/doctor.ps1` |
| `feat(core)` DLL 安装提示 | `src/ide/IdeExtensionPrompt.{hpp,cpp}`、`src/ide/IdeExtensionLogic.hpp`、`src/core/DllIdentity.hpp`、`src/main.cpp`、`tests/test_ide_extension.cpp` |
| `fix(launcher)` 支持 IDE 主程序名 | `src/launcher/AntigravityLauncher.cpp`、`scripts/launcher/{install-windows,test-resilience}.ps1` |
| `feat(scripts)` 在线安装 | `scripts/install-online.ps1` |
| `docs` README 精简 | `README*.md`、`docs/{configuration,troubleshooting,wsl}.md`（新）、`docs/DEVELOPMENT.md`、`docs/ide-extension.md` |

## 3. 验证

- 单元测试：ctest 8/8（新增 `ide_extension_tests`）；node 33/33（新增 `i18n.test.js`、`proxyScan.test.js`）。
- IDE 2.6.0 隔离副本端到端（复制安装目录 + 临时 profile / extensions + CDP，未触碰正在使用的 IDE）：
  - 三语热切换；扫描命中本机 7890 / 7891；首次引导可用 / 不可用 / 无结果三条分支；填入 → 保存 → 撤下引导；
  - 发布目录启动器拉起 → DLL 询问 → 安装 → 插件热加载 → 首次引导接管；已安装不再询问；选择「否」后同版本不再询问。
- 在线安装：PS 5.1 模拟一行命令、pwsh 7 指定版本，安装 v2.4 到隔离副本 → 补 doctor.ps1 → 部署成功（哈希一致、
  `config.json` 保留、退出码 0、窗口未被关闭）；伪造哈希时逐源换源后失败；无效版本号 / 目录被拒绝。

## 4. 过程中发现的问题

| 问题 | 处理 |
|:--|:--|
| `build.ps1` 选中 VSIX 暂存目录里的旧 `version.dll`，output 一直是旧 DLL | 排除暂存目录并按修改时间取最新 |
| 语言切换后连通测试结果仍是旧语言 | 收到 `lang` 消息时重新探测 |
| “未找到代理”提示的方位写反 | 改为“上方” |
| PS 5.1 的 WebRequest 不读 `HTTPS_PROXY`，只开端口代理的机器直连失败 | 在线安装显式接入环境变量代理 |
| 英文界面 + 中文区域的用户看到英文提示 | 界面语言非中 / 俄时回退看区域格式 |
| 带 BOM 的脚本经 `iex` 执行报 `﻿param` 无法识别 | 一行命令用 `WebClient.DownloadString`（按 BOM 解码并去掉 BOM）+ `scriptblock` 执行 |
| v2.4 发布包不含 doctor.ps1 | 在线安装从仓库主分支补取 |
| 文档中的注入日志写成「已注入目标进程」 | 按源码更正为「已注入新建进程」（`Hooks.cpp:3812`） |

## 5. 后续事项

- 在线安装一行命令读取 main 分支上的脚本，合并到 main 后可用；`SHA256SUMS.txt` 与插件独立资产从下一个 Release（打 `v*` tag）开始提供。
- 在线安装在没有 SHA256SUMS 的旧版本上只告警不阻断；有清单时校验不一致会换源，全部不一致才失败。
