// @ts-check
"use strict";

/**
 * 共享配置核心加载器。
 * - 打包后：build.ps1 将 resources/shared/config-core.js 复制到插件 media/（Webview 也从该处加载）
 * - 仓库内开发/单元测试：直接引用 resources/shared/config-core.js（唯一源文件，避免复制品漂移）
 */
let core;
try {
  core = require("../media/config-core.js");
} catch {
  core = require("../../shared/config-core.js");
}
module.exports = core;
