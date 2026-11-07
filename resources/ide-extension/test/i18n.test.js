// 多语言完整性测试：node --test resources/ide-extension/test/i18n.test.js
// 守护三件事：①每个词条三种语言齐全；②三种语言占位符一致；③源码中用到的 key 都存在（防止漏译/拼错）。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const I18n = require("../media/i18n.js");
const Core = require("../../shared/config-core.js");

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("插件词条：三种语言齐全且占位符一致", () => {
  for (const [key, entry] of Object.entries(I18n.MESSAGES)) {
    assert.equal(entry.length, 3, `${key} 应有 3 种语言`);
    entry.forEach((s, i) => assert.ok(typeof s === "string" && s.length > 0, `${key}[${I18n.LANGS[i]}] 为空`));
    assert.equal(placeholders(entry[1]), placeholders(entry[0]), `${key} 英文占位符与中文不一致`);
    assert.equal(placeholders(entry[2]), placeholders(entry[0]), `${key} 俄文占位符与中文不一致`);
  }
});

test("配置校验词条：三种语言齐全且占位符一致", () => {
  for (const [key, entry] of Object.entries(Core.VALIDATION_MESSAGES)) {
    assert.equal(entry.length, 3, `${key} 应有 3 种语言`);
    entry.forEach((s) => assert.ok(s.length > 0, `${key} 存在空译文`));
    assert.equal(placeholders(entry[1]), placeholders(entry[0]), `${key} 英文占位符不一致`);
    assert.equal(placeholders(entry[2]), placeholders(entry[0]), `${key} 俄文占位符不一致`);
  }
});

test("源码中引用的词条 key 全部存在", () => {
  const root = path.join(__dirname, "..");
  const files = [
    "extension.js",
    "media/panel.js",
    ...fs.readdirSync(path.join(root, "lib")).map((f) => `lib/${f}`),
  ];
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(/\b(?:T|t|tr|this\.t)\(\s*"([a-zA-Z0-9_.]+)"/g)) {
      if (!I18n.MESSAGES[m[1]]) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("语言解析：auto 跟随 IDE，显式设置优先，未知语言回退英文", () => {
  assert.equal(I18n.resolveLang("auto", "zh-cn"), "zh-cn");
  assert.equal(I18n.resolveLang("auto", "zh-tw"), "zh-cn");
  assert.equal(I18n.resolveLang("auto", "ru"), "ru");
  assert.equal(I18n.resolveLang("auto", "de"), "en");
  assert.equal(I18n.resolveLang(undefined, undefined), "en");
  assert.equal(I18n.resolveLang("ru", "zh-cn"), "ru");
  assert.equal(I18n.resolveLang("en", "zh-cn"), "en");
});

test("翻译函数：参数替换、未知 key 原样返回", () => {
  const en = I18n.createT("en");
  const ru = I18n.createT("ru");
  assert.equal(en("sb.ok", { port: 7890 }), "Proxy 7890");
  assert.equal(ru("sb.ok", { port: 7890 }), "Прокси 7890");
  assert.equal(I18n.createT("zh-cn")("sb.unreachable", { port: 1 }), "代理 1 不可达");
  assert.equal(en("no.such.key"), "no.such.key");
});

test("校验提示随语言输出，默认保持中文", () => {
  const form = Core.defaultForm();
  form.proxy.port = 0;
  assert.match(Core.validateForm(form).warnings["proxy.port"], /禁用代理/);
  assert.match(Core.validateForm(form, "en").warnings["proxy.port"], /disables the proxy/);
  assert.match(Core.validateForm(form, "ru").warnings["proxy.port"], /отключает прокси/);
});
