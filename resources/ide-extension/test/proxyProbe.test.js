// proxyProbe 单元测试：用本地伪代理服务器覆盖 SOCKS5（免认证/账密/拒绝）与 HTTP CONNECT（200/407）以及端口不通。
// 运行：node --test resources/ide-extension/test/proxyProbe.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { probeProxy } = require("../lib/proxyProbe.js");

/** 启动一个只处理单连接协议的伪代理，返回端口与关闭函数 */
function startFake(handler) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      handler(sock);
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

/** 按顺序回应 SOCKS5 各阶段 */
function socks5Fake({ requireAuth = false, user = "u", pass = "p", rep = 0 } = {}) {
  return (sock) => {
    let phase = "greet";
    sock.on("data", (d) => {
      if (phase === "greet") {
        const methods = [...d.subarray(2, 2 + d[1])];
        if (requireAuth) {
          if (!methods.includes(2)) return sock.end(Buffer.from([5, 0xff]));
          phase = "auth";
          return sock.write(Buffer.from([5, 2]));
        }
        phase = "connect";
        return sock.write(Buffer.from([5, 0]));
      }
      if (phase === "auth") {
        const ul = d[1];
        const u = d.subarray(2, 2 + ul).toString();
        const p = d.subarray(3 + ul, 3 + ul + d[2 + ul]).toString();
        phase = "connect";
        return sock.write(Buffer.from([1, u === user && p === pass ? 0 : 1]));
      }
      if (phase === "connect") {
        sock.write(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  };
}

test("SOCKS5 免认证：隧道成功", async () => {
  const f = await startFake(socks5Fake());
  const r = await probeProxy({ host: "127.0.0.1", port: f.port, type: "socks5" });
  f.close();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.stage, "tunnel");
});

test("SOCKS5 账密：正确通过，错误报 auth 阶段", async () => {
  const f = await startFake(socks5Fake({ requireAuth: true }));
  const ok = await probeProxy({ host: "127.0.0.1", port: f.port, type: "socks5", username: "u", password: "p" });
  const bad = await probeProxy({ host: "127.0.0.1", port: f.port, type: "socks5", username: "u", password: "x" });
  const none = await probeProxy({ host: "127.0.0.1", port: f.port, type: "socks5" });
  f.close();
  assert.equal(ok.ok, true, ok.message);
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, "auth");
  assert.equal(none.ok, false);
  assert.match(none.message, /认证/);
});

test("SOCKS5 目标拒绝：报 tunnel 阶段与 REP 含义", async () => {
  const f = await startFake(socks5Fake({ rep: 5 }));
  const r = await probeProxy({ host: "127.0.0.1", port: f.port, type: "socks5" });
  f.close();
  assert.equal(r.ok, false);
  assert.equal(r.stage, "tunnel");
  assert.match(r.message, /REP=5/);
});

test("HTTP CONNECT：200 成功，407 报认证，类型不匹配给出提示", async () => {
  const ok = await startFake((s) => s.once("data", () => s.write("HTTP/1.1 200 Connection established\r\n\r\n")));
  const auth = await startFake((s) => s.once("data", (d) => {
    s.write(String(d).includes("Proxy-Authorization: Basic dTpw") ? "HTTP/1.1 200 OK\r\n\r\n" : "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  }));
  const r1 = await probeProxy({ host: "127.0.0.1", port: ok.port, type: "http" });
  const r2 = await probeProxy({ host: "127.0.0.1", port: auth.port, type: "http" });
  const r3 = await probeProxy({ host: "127.0.0.1", port: auth.port, type: "http", username: "u", password: "p" });
  // HTTP 端口被误配为 socks5：首字节不是 0x05
  const r4 = await probeProxy({ host: "127.0.0.1", port: ok.port, type: "socks5" });
  ok.close();
  auth.close();
  assert.equal(r1.ok, true, r1.message);
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, "auth");
  assert.equal(r3.ok, true, r3.message);
  assert.equal(r4.ok, false);
  assert.match(r4.message, /不是 SOCKS5/);
});

test("端口未监听：tcp 阶段失败并提示检查代理软件", async () => {
  const f = await startFake(() => {});
  const port = f.port;
  f.close();
  await new Promise((r) => setTimeout(r, 50));
  const r = await probeProxy({ host: "127.0.0.1", port, type: "socks5" }, { timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "tcp");
  assert.match(r.message, /ECONNREFUSED/);
});

test("tcpOnly 与端口 0", async () => {
  const f = await startFake(() => {});
  const r = await probeProxy({ host: "127.0.0.1", port: f.port, type: "socks5" }, { tcpOnly: true });
  f.close();
  assert.equal(r.ok, true);
  const zero = await probeProxy({ host: "127.0.0.1", port: 0, type: "socks5" });
  assert.equal(zero.stage, "config");
});
