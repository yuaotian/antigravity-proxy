// config-core 单元测试（node:test，零依赖）：node --test resources/shared/
// 覆盖：默认值合法性、规范化回退、导出保留未知字段、往返一致、校验文案、JSONC 容错。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("./config-core.js");

// 去掉每次生成都会变化的字段，便于做结构等价比较
const stripVolatile = (form) => {
  const f = Core.deepClone(form);
  delete f._build.date;
  f.proxy_rules.routing.rules.forEach((r) => delete r.__ui_id);
  return f;
};

test("默认配置导出后校验无错误", () => {
  const form = Core.defaultForm("2.5");
  const out = Core.exportObject(form, {}, "2.5");
  const { errors } = Core.validateForm(Core.normalizeForm(out, "2.5"));
  assert.deepEqual(errors, {});
  assert.equal(out._version, "2.5");
  assert.equal(out.proxy.port, 7890);
});

test("规范化：端口越界回退 7890，0 保留并给出警告", () => {
  assert.equal(Core.normalizeForm({ proxy: { port: 70000 } }).proxy.port, 7890);
  assert.equal(Core.normalizeForm({ proxy: { port: -1 } }).proxy.port, 7890);
  const zero = Core.normalizeForm({ proxy: { port: 0 } });
  assert.equal(zero.proxy.port, 0);
  assert.match(Core.validateForm(zero).warnings["proxy.port"], /禁用代理/);
});

test("规范化：枚举大小写与非法值回退，账密别名 user/pass", () => {
  const f = Core.normalizeForm({
    proxy: { type: "HTTP", user: "alice", pass: "s3cret" },
    proxy_rules: { dns_mode: "nope", udp_mode: "Proxy" },
    log_level: "警告",
  });
  assert.equal(f.proxy.type, "http");
  assert.equal(f.proxy.username, "alice");
  assert.equal(f.proxy.password, "s3cret");
  assert.equal(f.proxy_rules.dns_mode, "direct");
  assert.equal(f.proxy_rules.udp_mode, "proxy");
  assert.equal(f.log_level, "warn");
});

test("导出：保留未知字段，规则去掉 __ui_id", () => {
  const raw = {
    custom_field: { keep: true },
    proxy: { host: "10.0.0.2", port: 1080, type: "socks5", extra: "x" },
    proxy_rules: { routing: { rules: [{ name: "r1", domains: ["*.google.com"], ip_cidrs_v4: [], ports: ["443"] }] } },
  };
  const form = Core.normalizeForm(raw);
  const out = Core.exportObject(form, raw);
  assert.deepEqual(out.custom_field, { keep: true });
  assert.equal(out.proxy.extra, "x");
  assert.equal(out.proxy.host, "10.0.0.2");
  assert.equal(out.proxy_rules.routing.rules.length, 1);
  assert.equal("__ui_id" in out.proxy_rules.routing.rules[0], false);
});

test("往返一致：normalize(export(form)) 与原表单结构等价", () => {
  const form = Core.normalizeForm({
    proxy: { host: "127.0.0.1", port: 7897, type: "http", username: "u", password: "p" },
    target_processes: ["agy.exe", "node.exe"],
    proxy_rules: { allowed_ports: [443, 80], routing: { rules: [{ name: "a", domains: ["x.com"], action: "direct" }] } },
  });
  const again = Core.normalizeForm(Core.exportObject(form, {}));
  assert.deepEqual(stripVolatile(again), stripVolatile(form));
});

test("校验：CIDR / IPv6 / 端口范围 / 镜像 https", () => {
  const form = Core.defaultForm();
  form.fake_ip.cidr = "198.18.0.0/40";
  form.updates.mirrors = ["http://insecure.example/"];
  const rule = Core.defaultRoutingRule(0);
  rule.ip_cidrs_v6 = ["2001:db8::/32", "2001:::1/64"];
  rule.ports = ["443", "8000-8100", "70000"];
  form.proxy_rules.routing.rules = [rule];
  const { errors } = Core.validateForm(form);
  assert.match(errors["fake_ip.cidr"], /0-32/);
  assert.match(errors["updates.mirrors[0]"], /https/);
  assert.equal(errors["proxy_rules.routing.rules[0].ip_cidrs_v6[0]"], undefined);
  assert.match(errors["proxy_rules.routing.rules[0].ip_cidrs_v6[1]"], /IPv6/);
  assert.match(errors["proxy_rules.routing.rules[0].ports[2]"], /1-65535/);
  assert.deepEqual(Core.parsePortRange("9000-8000"), { ok: true, start: 8000, end: 9000 });
  assert.equal(Core.isValidIPv6("::ffff:192.168.1.1"), true);
  assert.equal(Core.isValidIPv4("256.0.0.1"), false);
});

test("JSONC 容错：BOM / 行注释 / 块注释 / 尾逗号，且不误伤字符串内的 //", () => {
  const text = "﻿{\n  // 注释\n  \"url\": \"https://a.b/c//d\", /* 块 */\n  \"arr\": [1, 2,],\n}";
  assert.deepEqual(Core.parseJsonc(text), { url: "https://a.b/c//d", arr: [1, 2] });
  assert.throws(() => Core.parseJsonc("{ not json"));
});

test("ENUMS 与校验取值一致（防止 UI 下拉与校验漂移）", () => {
  const form = Core.defaultForm();
  for (const t of Core.ENUMS["proxy.type"]) {
    form.proxy.type = t;
    assert.equal(Core.validateForm(form).errors["proxy.type"], undefined);
  }
  for (const m of Core.ENUMS["proxy_rules.udp_mode"]) {
    form.proxy_rules.udp_mode = m;
    assert.equal(Core.validateForm(form).errors["proxy_rules.udp_mode"], undefined);
  }
});
