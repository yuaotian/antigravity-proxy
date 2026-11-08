// @ts-check
"use strict";

/**
 * Webview HTML 生成（单一职责：CSP + 资源 URI + 首帧数据属性）。
 *
 * 与配置面板保持同一套安全策略（lib/configPanel.js:222-252）：
 * default-src 'none'，脚本仅 nonce，样式/字体/图片仅插件资源。
 * 因此前端不得使用内联 style="" 或 onclick=""，所有交互走 addEventListener + postMessage。
 */

const crypto = require("crypto");

const HTML_LANG = Object.freeze({ "zh-cn": "zh-CN", en: "en", ru: "ru" });

/** @param {unknown} value */
function escapeAttr(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * @param {{
 *   vscode: typeof import("vscode"),
 *   webview: import("vscode").Webview,
 *   mediaUri: import("vscode").Uri,
 *   title: string,
 *   lang: string,
 *   data?: Record<string, string>,
 *   styles: string[],
 *   scripts: string[],
 *   bodyClass?: string,
 * }} opts
 */
function renderWebviewHtml(opts) {
  const { vscode, webview, mediaUri, title, lang, styles, scripts } = opts;
  const nonce = crypto.randomBytes(16).toString("base64");
  const uri = (/** @type {string} */ file) => webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, file)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const dataAttrs = Object.entries(opts.data || {})
    .map(([key, value]) => `data-${key}="${escapeAttr(value)}"`)
    .join(" ");
  const css = styles.map((f) => `  <link rel="stylesheet" href="${uri(f)}" />`).join("\n");
  const js = scripts.map((f) => `  <script nonce="${nonce}" src="${uri(f)}"></script>`).join("\n");
  const bodyClass = opts.bodyClass ? ` class="${escapeAttr(opts.bodyClass)}"` : "";
  return `<!DOCTYPE html>
<html lang="${HTML_LANG[lang] || "en"}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
${css}
  <title>${escapeAttr(title)}</title>
</head>
<body${bodyClass}>
  <div id="app" data-lang="${escapeAttr(lang)}" ${dataAttrs}></div>
${js}
</body>
</html>`;
}

module.exports = { renderWebviewHtml, escapeAttr, HTML_LANG };
