const defaultRouting = () => ({
  enabled: true,
  priority_mode: "order",
  default_action: "proxy",
  use_default_private: true,
  rules: [
    {
      name: "lan-direct",
      enabled: true,
      action: "direct",
      priority: 0,
      ip_cidrs_v4: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"],
      ip_cidrs_v6: ["fc00::/7", "fe80::/10", "::1/128"],
      domains: [".local", ".lan", "*.corp.example.com"],
      ports: ["445", "3389", "10000-20000"],
      protocols: ["tcp"],
    },
  ],
});

const defaultRule = () => ({
  name: "new-rule",
  enabled: true,
  action: "proxy",
  priority: 0,
  ip_cidrs_v4: [],
  ip_cidrs_v6: [],
  domains: [],
  ports: [],
  protocols: ["tcp"],
});

let baseConfig = {};
let routing = defaultRouting();
let selectedIndex = 0;

const $ = (id) => document.getElementById(id);

const elements = {
  configFile: $("configFile"),
  btnDownload: $("btnDownload"),
  btnLoadExample: $("btnLoadExample"),
  routingEnabled: $("routingEnabled"),
  priorityMode: $("priorityMode"),
  defaultAction: $("defaultAction"),
  useDefaultPrivate: $("useDefaultPrivate"),
  priorityWarning: $("priorityWarning"),
  ruleList: $("ruleList"),
  btnAddRule: $("btnAddRule"),
  btnCloneRule: $("btnCloneRule"),
  btnDeleteRule: $("btnDeleteRule"),
  btnMoveUp: $("btnMoveUp"),
  btnMoveDown: $("btnMoveDown"),
  ruleName: $("ruleName"),
  ruleEnabled: $("ruleEnabled"),
  ruleAction: $("ruleAction"),
  rulePriority: $("rulePriority"),
  ruleIpv4: $("ruleIpv4"),
  ruleIpv6: $("ruleIpv6"),
  ruleDomains: $("ruleDomains"),
  rulePorts: $("rulePorts"),
  ruleProtocols: $("ruleProtocols"),
  testHost: $("testHost"),
  testPort: $("testPort"),
  testProto: $("testProto"),
  btnTest: $("btnTest"),
  testResult: $("testResult"),
  proxyType: $("proxyType"),
  proxyHost: $("proxyHost"),
  proxyPort: $("proxyPort"),
};

const normalizeRouting = (input) => {
  const base = defaultRouting();
  const out = {
    enabled: input?.enabled ?? base.enabled,
    priority_mode: input?.priority_mode ?? base.priority_mode,
    default_action: input?.default_action ?? base.default_action,
    use_default_private: input?.use_default_private ?? base.use_default_private,
    rules: Array.isArray(input?.rules) ? input.rules : base.rules,
  };
  out.rules = out.rules.map((rule, idx) => ({
    ...defaultRule(),
    ...rule,
    name: rule?.name || `rule-${idx + 1}`,
    ip_cidrs_v4: Array.isArray(rule?.ip_cidrs_v4) ? rule.ip_cidrs_v4 : [],
    ip_cidrs_v6: Array.isArray(rule?.ip_cidrs_v6) ? rule.ip_cidrs_v6 : [],
    domains: Array.isArray(rule?.domains) ? rule.domains : [],
    ports: Array.isArray(rule?.ports) ? rule.ports : [],
    protocols: Array.isArray(rule?.protocols) ? rule.protocols : ["tcp"],
  }));
  return out;
};

const parseList = (text) =>
  text
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);

const listToText = (list) => (list || []).join("\n");

const renderGlobal = () => {
  elements.routingEnabled.checked = !!routing.enabled;
  elements.priorityMode.value = routing.priority_mode || "order";
  elements.defaultAction.value = routing.default_action || "proxy";
  elements.useDefaultPrivate.checked = !!routing.use_default_private;

  const mode = elements.priorityMode.value;
  if (mode === "order") {
    elements.priorityWarning.textContent = "强提醒：当前为【按列表顺序】模式，规则的上下顺序就是最终生效顺序。拖动/移动规则会直接改变结果。";
  } else {
    elements.priorityWarning.textContent = "强提醒：当前为【按 priority 数值】模式，priority 越大越优先。列表顺序不代表生效顺序。";
  }
};

const renderProxy = () => {
  const proxy = baseConfig.proxy || {};
  elements.proxyType.value = proxy.type || "socks5";
  elements.proxyHost.value = proxy.host || "127.0.0.1";
  elements.proxyPort.value = proxy.port ?? 7890;
};

const renderRuleList = () => {
  elements.ruleList.innerHTML = "";
  routing.rules.forEach((rule, idx) => {
    const li = document.createElement("li");
    li.className = idx === selectedIndex ? "active" : "";
    li.innerHTML = `<span>${rule.name || "(未命名)"}</span><span>${rule.action || "proxy"}</span>`;
    li.addEventListener("click", () => {
      selectedIndex = idx;
      renderRuleList();
      renderRuleEditor();
    });
    elements.ruleList.appendChild(li);
  });
};

const renderRuleEditor = () => {
  const rule = routing.rules[selectedIndex] || defaultRule();
  elements.ruleName.value = rule.name || "";
  elements.ruleEnabled.checked = !!rule.enabled;
  elements.ruleAction.value = rule.action || "proxy";
  elements.rulePriority.value = rule.priority ?? 0;
  elements.ruleIpv4.value = listToText(rule.ip_cidrs_v4);
  elements.ruleIpv6.value = listToText(rule.ip_cidrs_v6);
  elements.ruleDomains.value = listToText(rule.domains);
  elements.rulePorts.value = listToText(rule.ports);
  elements.ruleProtocols.value = (rule.protocols || []).join(", ");
};

const updateRuleFromEditor = () => {
  const rule = routing.rules[selectedIndex];
  if (!rule) return;
  rule.name = elements.ruleName.value.trim() || "(未命名)";
  rule.enabled = elements.ruleEnabled.checked;
  rule.action = elements.ruleAction.value;
  rule.priority = parseInt(elements.rulePriority.value || "0", 10) || 0;
  rule.ip_cidrs_v4 = parseList(elements.ruleIpv4.value);
  rule.ip_cidrs_v6 = parseList(elements.ruleIpv6.value);
  rule.domains = parseList(elements.ruleDomains.value);
  rule.ports = parseList(elements.rulePorts.value);
  rule.protocols = parseList(elements.ruleProtocols.value);
  renderRuleList();
};

const syncGlobalFromEditor = () => {
  routing.enabled = elements.routingEnabled.checked;
  routing.priority_mode = elements.priorityMode.value;
  routing.default_action = elements.defaultAction.value;
  routing.use_default_private = elements.useDefaultPrivate.checked;
  renderGlobal();
};

const loadConfig = (json) => {
  baseConfig = json || {};
  const incoming = baseConfig?.proxy_rules?.routing;
  routing = normalizeRouting(incoming);
  selectedIndex = 0;
  renderGlobal();
  renderProxy();
  renderRuleList();
  renderRuleEditor();
};

const downloadConfig = () => {
  const out = JSON.parse(JSON.stringify(baseConfig || {}));
  if (!out.proxy_rules) out.proxy_rules = {};
  out.proxy_rules.routing = routing;
  if (!out.proxy) out.proxy = {};
  out.proxy.type = elements.proxyType.value || "socks5";
  out.proxy.host = elements.proxyHost.value.trim() || "127.0.0.1";
  const portValue = parseInt(elements.proxyPort.value || "7890", 10);
  out.proxy.port = Number.isFinite(portValue) ? portValue : 7890;
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "config.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const defaultPrivateRule = () => ({
  name: "default-private",
  enabled: true,
  action: "direct",
  priority: 1000,
  ip_cidrs_v4: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"],
  ip_cidrs_v6: ["fc00::/7", "fe80::/10", "::1/128"],
  domains: [],
  ports: [],
  protocols: ["tcp"],
});

const getEffectiveRules = () => {
  const rules = routing.rules.slice();
  if (routing.use_default_private) rules.unshift(defaultPrivateRule());
  if (routing.priority_mode === "number") {
    return rules.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }
  return rules;
};

const globMatch = (pattern, text) => {
  let p = 0;
  let t = 0;
  let star = -1;
  let match = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      match = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++match;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
};

const matchDomainPattern = (pattern, host) => {
  if (!pattern || !host) return false;
  let p = pattern.toLowerCase();
  let h = host.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  const hasWildcard = p.includes("*") || p.includes("?");
  if (!hasWildcard && p.startsWith(".")) {
    const root = p.slice(1);
    if (h === root) return true;
    return h.endsWith(p);
  }
  if (!hasWildcard) return h === p;
  return globMatch(p, h);
};

const parseIPv4 = (ip) => {
  const parts = ip.split(".").map((p) => p.trim());
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255 ? n : null;
  });
  if (nums.some((n) => n === null)) return null;
  return (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3];
};

const parseIPv6 = (input) => {
  if (!input) return null;
  let ip = input.trim().toLowerCase();
  if (!ip) return null;
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const total = left.length + right.length;
  if (total > 8) return null;
  const fill = new Array(8 - total).fill("0");
  const words = [...left, ...fill, ...right].map((p) => {
    if (!p) return 0;
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    return parseInt(p, 16);
  });
  if (words.some((w) => w === null)) return null;
  const bytes = new Uint8Array(16);
  words.forEach((w, idx) => {
    bytes[idx * 2] = (w >> 8) & 0xff;
    bytes[idx * 2 + 1] = w & 0xff;
  });
  return bytes;
};

const parseCidrV4 = (cidr) => {
  const [ip, bits] = cidr.split("/");
  if (!ip || bits === undefined) return null;
  const addr = parseIPv4(ip);
  const size = parseInt(bits, 10);
  if (addr === null || isNaN(size) || size < 0 || size > 32) return null;
  const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
  return { network: addr & mask, mask };
};

const parseCidrV6 = (cidr) => {
  const [ip, bits] = cidr.split("/");
  if (!ip || bits === undefined) return null;
  const addr = parseIPv6(ip);
  const size = parseInt(bits, 10);
  if (!addr || isNaN(size) || size < 0 || size > 128) return null;
  return { network: addr, prefix: size };
};

const matchCidrV4 = (ip, rule) => (ip & rule.mask) === rule.network;

const matchCidrV6 = (ip, rule) => {
  const bits = rule.prefix;
  const full = Math.floor(bits / 8);
  const rem = bits % 8;
  for (let i = 0; i < full; i++) {
    if (ip[i] !== rule.network[i]) return false;
  }
  if (rem === 0) return true;
  const mask = 0xff << (8 - rem);
  return (ip[full] & mask) === (rule.network[full] & mask);
};

const parsePortRanges = (list) =>
  list
    .map((item) => item.trim())
    .filter(Boolean)
    .map((token) => {
      if (/^\d+$/.test(token)) {
        const v = parseInt(token, 10);
        return v >= 0 && v <= 65535 ? { start: v, end: v } : null;
      }
      const m = token.match(/^(\d+)-(\d+)$/);
      if (!m) return null;
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      if (a < 0 || b > 65535) return null;
      return { start: a, end: b };
    })
    .filter(Boolean);

const matchPorts = (port, ranges) => {
  if (!ranges.length) return true;
  if (!port) return false;
  return ranges.some((r) => port >= r.start && port <= r.end);
};

const matchProtocols = (proto, list) => {
  if (!list.length) return true;
  const p = (proto || "").toLowerCase();
  return list.some((x) => x.toLowerCase() === p);
};

const matchRouting = (host, port, proto) => {
  if (!routing.enabled) return { action: "proxy", rule: "(disabled)" };
  const rules = getEffectiveRules();
  const hostStr = host?.trim() || "";
  const ip4 = parseIPv4(hostStr);
  const ip6 = ip4 === null ? parseIPv6(hostStr) : null;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchProtocols(proto, rule.protocols || [])) continue;
    if (!matchPorts(port, parsePortRanges(rule.ports || []))) continue;

    if (rule.domains && rule.domains.some((p) => matchDomainPattern(p, hostStr))) {
      return { action: rule.action || routing.default_action, rule: rule.name };
    }

    if (ip4 !== null && rule.ip_cidrs_v4) {
      for (const cidr of rule.ip_cidrs_v4) {
        const parsed = parseCidrV4(cidr);
        if (parsed && matchCidrV4(ip4, parsed)) {
          return { action: rule.action || routing.default_action, rule: rule.name };
        }
      }
    }

    if (ip6 && rule.ip_cidrs_v6) {
      for (const cidr of rule.ip_cidrs_v6) {
        const parsed = parseCidrV6(cidr);
        if (parsed && matchCidrV6(ip6, parsed)) {
          return { action: rule.action || routing.default_action, rule: rule.name };
        }
      }
    }
  }

  return { action: routing.default_action || "proxy", rule: "(default)" };
};

const bindEvents = () => {
  elements.configFile.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        loadConfig(json);
      } catch (err) {
        alert("无法解析 JSON：" + err.message);
      }
    };
    reader.readAsText(file);
  });

  elements.btnDownload.addEventListener("click", () => {
    updateRuleFromEditor();
    syncGlobalFromEditor();
    downloadConfig();
  });

  elements.btnLoadExample.addEventListener("click", () => {
    baseConfig = {};
    routing = defaultRouting();
    selectedIndex = 0;
    renderGlobal();
    renderRuleList();
    renderRuleEditor();
  });

  [
    elements.routingEnabled,
    elements.priorityMode,
    elements.defaultAction,
    elements.useDefaultPrivate,
  ].forEach((el) => el.addEventListener("change", syncGlobalFromEditor));

  [
    elements.ruleName,
    elements.ruleEnabled,
    elements.ruleAction,
    elements.rulePriority,
    elements.ruleIpv4,
    elements.ruleIpv6,
    elements.ruleDomains,
    elements.rulePorts,
    elements.ruleProtocols,
  ].forEach((el) => el.addEventListener("input", updateRuleFromEditor));

  elements.btnAddRule.addEventListener("click", () => {
    routing.rules.push(defaultRule());
    selectedIndex = routing.rules.length - 1;
    renderRuleList();
    renderRuleEditor();
  });

  elements.btnCloneRule.addEventListener("click", () => {
    const rule = routing.rules[selectedIndex];
    if (!rule) return;
    const clone = JSON.parse(JSON.stringify(rule));
    clone.name = `${rule.name || "rule"}-copy`;
    routing.rules.push(clone);
    selectedIndex = routing.rules.length - 1;
    renderRuleList();
    renderRuleEditor();
  });

  elements.btnDeleteRule.addEventListener("click", () => {
    if (!routing.rules.length) return;
    routing.rules.splice(selectedIndex, 1);
    if (selectedIndex >= routing.rules.length) selectedIndex = routing.rules.length - 1;
    if (selectedIndex < 0) selectedIndex = 0;
    renderRuleList();
    renderRuleEditor();
  });

  elements.btnMoveUp.addEventListener("click", () => {
    if (selectedIndex <= 0) return;
    const tmp = routing.rules[selectedIndex - 1];
    routing.rules[selectedIndex - 1] = routing.rules[selectedIndex];
    routing.rules[selectedIndex] = tmp;
    selectedIndex -= 1;
    renderRuleList();
  });

  elements.btnMoveDown.addEventListener("click", () => {
    if (selectedIndex >= routing.rules.length - 1) return;
    const tmp = routing.rules[selectedIndex + 1];
    routing.rules[selectedIndex + 1] = routing.rules[selectedIndex];
    routing.rules[selectedIndex] = tmp;
    selectedIndex += 1;
    renderRuleList();
  });

  elements.btnTest.addEventListener("click", () => {
    const host = elements.testHost.value.trim();
    const port = parseInt(elements.testPort.value || "0", 10) || 0;
    const proto = elements.testProto.value;
    updateRuleFromEditor();
    syncGlobalFromEditor();
    const result = matchRouting(host, port, proto);
    elements.testResult.textContent = `结果：${result.action} （命中：${result.rule}）`;
  });
};

const init = () => {
  loadConfig({});
  bindEvents();
};

init();
