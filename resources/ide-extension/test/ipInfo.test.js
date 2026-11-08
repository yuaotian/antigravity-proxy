// 纯逻辑单测：node --test resources/ide-extension/test/ipInfo.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Ip = require("../lib/ipInfo.js");

test("org 拆分：ASN + 运营商名，无 AS 前缀时原样返回", () => {
  assert.deepEqual(Ip.splitOrg("AS4657 StarHub Ltd"), { asn: "AS4657", orgName: "StarHub Ltd" });
  assert.deepEqual(Ip.splitOrg("AS15169 Google LLC"), { asn: "AS15169", orgName: "Google LLC" });
  assert.deepEqual(Ip.splitOrg("StarHub Ltd"), { asn: "", orgName: "StarHub Ltd" });
  assert.deepEqual(Ip.splitOrg(""), { asn: "", orgName: "" });
});

test("机房/托管特征：命中 DLL 同源关键字", () => {
  assert.equal(Ip.isDatacenterOrg("AS14061 DigitalOcean, LLC"), true);
  assert.equal(Ip.isDatacenterOrg("AS16509 Amazon.com, Inc."), true);
  assert.equal(Ip.isDatacenterOrg("AS4657 StarHub Ltd"), false);
  assert.equal(Ip.isDatacenterOrg(""), false);
});

test("ipinfo 解析：样例（新加坡 StarHub）字段完整", () => {
  const data = Ip.parseIpInfo({
    ip: "202.156.27.9",
    city: "Choa Chu Kang New Town",
    region: "Singapore",
    country: "SG",
    loc: "1.3825,103.7497",
    org: "AS4657 StarHub Ltd",
    timezone: "Asia/Singapore",
  });
  assert.equal(data.ip, "202.156.27.9");
  assert.equal(data.asn, "AS4657");
  assert.equal(data.orgName, "StarHub Ltd");
  assert.equal(data.country, "SG");
  assert.equal(data.city, "Choa Chu Kang New Town");
  assert.equal(data.datacenter, false);
  assert.equal(data.prefix24, "202.156.27.0/24");
});

test("ipinfo 解析：缺少 ip 视为无效响应", () => {
  assert.throws(() => Ip.parseIpInfo({}), /no ip field/);
  assert.throws(() => Ip.parseIpInfo(null), /no ip field/);
});
