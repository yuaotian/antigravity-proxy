// 本机代理扫描单元测试：node --test resources/ide-extension/test/proxyScan.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { scanLocalProxies, parseProxyUrl, parseWindowsProxyServer } = require("../lib/proxyScan.js");

/** 启动伪代理，返回端口与关闭函数 */
function startFake(handler) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      handler(sock);
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

/** 仅支持 SOCKS5（免认证）的伪代理；收到非 SOCKS5 数据直接断开 */
const socksOnly = (sock) => {
  let phase = "greet";
  sock.on("data", (d) => {
    if (phase === "greet") {
      if (d[0] !== 5) return sock.destroy();
      phase = "connect";
      return sock.write(Buffer.from([5, 0]));
    }
    sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
  });
};

/** 仅支持 HTTP CONNECT 的伪代理 */
const httpOnly = (sock) => {
  sock.on("data", (d) => {
    if (String(d).startsWith("CONNECT ")) sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
    else sock.destroy();
  });
};

/** 取一个当前未被监听的端口 */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test("代理地址解析：URL / 账密 / 纯 host:port / 非法值", () => {
  assert.deepEqual(parseProxyUrl("http://127.0.0.1:7890"), { host: "127.0.0.1", port: 7890, hint: "http" });
  assert.deepEqual(parseProxyUrl("socks5://u:p@localhost:1080/"), { host: "localhost", port: 1080, hint: "socks5" });
  assert.deepEqual(parseProxyUrl("127.0.0.1:10808"), { host: "127.0.0.1", port: 10808 });
  assert.equal(parseProxyUrl(""), null);
  assert.equal(parseProxyUrl("http://127.0.0.1:99999"), null);
  assert.equal(parseProxyUrl("not a proxy"), null);
});

test("Windows 系统代理解析：单一地址与按协议分开的写法", () => {
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:7890"), [{ host: "127.0.0.1", port: 7890 }]);
  assert.deepEqual(parseWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"), [
    { host: "127.0.0.1", port: 7890, hint: "http" },
    { host: "127.0.0.1", port: 7890, hint: "http" },
    { host: "127.0.0.1", port: 7891, hint: "socks5" },
  ]);
  assert.deepEqual(parseWindowsProxyServer(null), []);
});

test("扫描：识别 SOCKS5 与 HTTP 端口、跳过未监听端口，来源合并且按可信度排序", async () => {
  const s5 = await startFake(socksOnly);
  const hp = await startFake(httpOnly);
  const closed = await freePort();
  try {
    const r = await scanLocalProxies({
      ports: [s5.port, closed],
      systemProxy: `127.0.0.1:${hp.port}`,
      env: { HTTP_PROXY: `http://127.0.0.1:${s5.port}` },
      ideProxy: "",
      current: null,
      probeTimeoutMs: 2000,
    });
    assert.equal(r.scanned, 3);
    assert.equal(r.candidates.length, 2);
    const [first, second] = r.candidates;
    // 系统代理（rank 2）排在 环境变量+常用端口（rank 3）之前
    assert.equal(first.port, hp.port);
    assert.equal(first.type, "http");
    assert.deepEqual(first.sources, ["system"]);
    assert.equal(second.port, s5.port);
    assert.equal(second.type, "socks5");
    assert.deepEqual(second.sources, ["env", "port"]);
  } finally {
    s5.close();
    hp.close();
  }
});

test("扫描：全部不可用时返回空列表（不抛错）", async () => {
  const closed = await freePort();
  const r = await scanLocalProxies({ ports: [closed], systemProxy: null, env: {}, current: null });
  assert.deepEqual(r.candidates, []);
  assert.equal(r.scanned, 1);
});
