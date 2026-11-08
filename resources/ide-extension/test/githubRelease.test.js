// 纯逻辑单测：node --test resources/ide-extension/test/githubRelease.test.js
// 覆盖版本比较、Release 解析、按架构选 VSIX、镜像拼接与 SHA256SUMS 解析。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/githubRelease.js");

test("版本比较：忽略 v 前缀，缺位按 0，非数字部分忽略", () => {
  assert.equal(R.compareVersions("2.6.0", "2.6"), 0);
  assert.equal(R.compareVersions("v2.6", "2.6.0"), 0);
  assert.equal(R.compareVersions("2.6", "2.7"), -1);
  assert.equal(R.compareVersions("2.10.1", "2.9.9"), 1);
  assert.equal(R.compareVersions("2.6.0-beta", "2.6.0"), 0);
  assert.equal(R.compareVersions("dev", "2.6"), 0);
  assert.equal(R.isNewer("2.6.0", "v2.7"), true);
  assert.equal(R.isNewer("2.7.0", "v2.6"), false);
  assert.equal(R.isNewer("2.7.0", "v2.7.0"), false);
});

test("Release 解析：只保留 https 资产，字段缺失时返回 null", () => {
  const info = R.parseRelease({
    tag_name: "v2.6",
    name: "v2.6",
    body: "notes",
    html_url: "https://github.com/yuaotian/antigravity-proxy/releases/tag/v2.6",
    published_at: "2026-11-07T12:00:47Z",
    assets: [
      { name: "antigravity-proxy-v2.6-ide-extension-win-x64.vsix", size: 531380, browser_download_url: "https://github.com/a/x64.vsix" },
      { name: "antigravity-proxy-v2.6-ide-extension-win-x86.vsix", size: 489467, browser_download_url: "https://github.com/a/x86.vsix" },
      { name: "SHA256SUMS.txt", size: 652, browser_download_url: "https://github.com/a/SHA256SUMS.txt" },
      { name: "bad.vsix", browser_download_url: "http://insecure.example/bad.vsix" },
    ],
  });
  assert.equal(info.tag, "v2.6");
  assert.equal(info.version, "2.6");
  assert.equal(info.assets.length, 3);

  assert.equal(R.parseRelease(null), null);
  assert.equal(R.parseRelease({}), null);
  assert.equal(R.parseRelease({ tag_name: "  " }), null);
});

test("按 IDE 架构选择 VSIX；未知架构返回 null", () => {
  const info = R.parseRelease({
    tag_name: "v2.6",
    assets: [
      { name: "antigravity-proxy-v2.6-ide-extension-win-x64.vsix", browser_download_url: "https://github.com/a/x64.vsix" },
      { name: "antigravity-proxy-v2.6-ide-extension-win-x86.vsix", browser_download_url: "https://github.com/a/x86.vsix" },
      { name: "antigravity-proxy-v2.6-ide-win-x64.zip", browser_download_url: "https://github.com/a/ide.zip" },
    ],
  });
  assert.equal(R.pickVsixAsset(info.assets, "x64").name, "antigravity-proxy-v2.6-ide-extension-win-x64.vsix");
  assert.equal(R.pickVsixAsset(info.assets, "ia32").name, "antigravity-proxy-v2.6-ide-extension-win-x86.vsix");
  assert.equal(R.pickVsixAsset(info.assets, "arm64"), null);
});

test("镜像拼接：只接受 https，自动补斜杠，顺序保持配置顺序", () => {
  assert.equal(R.joinMirror("https://gh-proxy.com", "https://api.github.com/x"), "https://gh-proxy.com/https://api.github.com/x");
  assert.equal(R.joinMirror("https://gh-proxy.com/", "https://api.github.com/x"), "https://gh-proxy.com/https://api.github.com/x");
  assert.equal(R.joinMirror("http://insecure", "https://api.github.com/x"), "");
  assert.equal(R.joinMirror("", "https://api.github.com/x"), "");

  const list = R.buildMirrorCandidates("https://api.github.com/x", ["https://a.example/", "https://b.example/"]);
  assert.deepEqual(list.map((c) => c.url), [
    "https://a.example/https://api.github.com/x",
    "https://b.example/https://api.github.com/x",
  ]);
  assert.equal(R.mirrorHost("https://gh-proxy.com/"), "gh-proxy.com");
});

test("SHA256SUMS 解析：标准格式与 *文件名", () => {
  const hex = "a".repeat(64);
  const map = R.parseSha256Sums(`${hex}  antigravity-proxy-v2.6-ide-extension-win-x64.vsix\n${hex} *antigravity-proxy-v2.6-ide-win-x64.zip\nnot a line`);
  assert.equal(map.get("antigravity-proxy-v2.6-ide-extension-win-x64.vsix"), hex);
  assert.equal(map.get("antigravity-proxy-v2.6-ide-win-x64.zip"), hex);
  assert.equal(map.size, 2);
});
