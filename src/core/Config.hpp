#pragma once
#include <nlohmann/json.hpp>
#include <fstream>
#include <string>
#include <vector>
#include <algorithm>
#include <cctype>
#include <array>
#include <sstream>
#include <cstdint>
#include "Logger.hpp"

namespace Core {
    struct ProxyConfig {
        std::string host = "127.0.0.1";
        int port = 7890;
        std::string type = "socks5";
    };

    struct FakeIPConfig {
        bool enabled = true;
        std::string cidr = "198.18.0.0/15";
        // 注：max_entries 已废弃，Ring Buffer 策略下自动循环复用地址池
    };

    struct TimeoutConfig {
        int connect_ms = 5000;
        int send_ms = 5000;
        int recv_ms = 5000;
    };

    // ============= 路由规则配置（支持 IP/CIDR/域名通配符/端口/协议） =============
    struct RoutingRule {
        std::string name;
        bool enabled = true;
        std::string action = "proxy"; // direct/proxy
        int priority = 0;             // priority_mode=number 时使用
        std::vector<std::string> ip_cidrs_v4;
        std::vector<std::string> ip_cidrs_v6;
        std::vector<std::string> domains;   // 支持通配符与后缀
        std::vector<std::string> ports;     // 80 / 443 / 10000-20000
        std::vector<std::string> protocols; // tcp
    };

    struct RoutingConfig {
        bool enabled = true;
        std::string priority_mode = "order"; // order/number
        std::string default_action = "proxy";
        bool use_default_private = true;
        std::vector<RoutingRule> rules;
    };

    // ============= 代理路由规则 =============
    // 用于控制哪些端口走代理、DNS 53 端口的特殊处理策略
    struct ProxyRules {
        // 允许代理的目标端口白名单（为空则代理所有端口）
        // 默认: 仅代理 HTTP(80) 和 HTTPS(443)
        std::vector<uint16_t> allowed_ports = {80, 443};
        
        // DNS (Port 53) 处理策略
        // "direct" - 直连, 不经代理 (默认, 解决 DNS 超时问题)
        // "proxy"  - 走代理
        std::string dns_mode = "direct";
        
        // IPv6 处理策略
        // "proxy"  - IPv6 走代理 (默认，兼容 IPv4/IPv6)
        // "direct" - IPv6 直连
        // "block"  - 阻止 IPv6 连接
        std::string ipv6_mode = "proxy";

        // UDP 处理策略
        // "block"  - 阻断 UDP（默认，国内必须代理场景下可强制回退 TCP，避免 QUIC/HTTP3 绕过代理）
        // "direct" - UDP 直连（保持现状）
        std::string udp_mode = "block";

        // 路由规则（内网/域名/端口/协议分流）
        RoutingConfig routing;

        struct CidrRuleV4 {
            uint32_t network;  // host order
            uint32_t mask;     // host order
        };

        struct CidrRuleV6 {
            std::array<uint8_t, 16> network{};
            int prefix = 0;
        };

        struct PortRange {
            uint16_t start = 0;
            uint16_t end = 0;
        };

        struct CompiledRoutingRule {
            RoutingRule raw;
            std::vector<CidrRuleV4> v4;
            std::vector<CidrRuleV6> v6;
            std::vector<std::string> domains; // lowercased
            std::vector<PortRange> port_ranges;
            std::vector<std::string> protocols; // lowercased
        };

        std::vector<CompiledRoutingRule> compiled_rules;
        std::vector<size_t> compiled_order;

        // 快速判断端口是否在白名单中
        bool IsPortAllowed(uint16_t port) const {
            if (allowed_ports.empty()) return true; // 空白名单 = 允许所有
            return std::find(allowed_ports.begin(), allowed_ports.end(), port) 
                   != allowed_ports.end();
        }

        static std::string ToLower(std::string s) {
            std::transform(s.begin(), s.end(), s.begin(),
                [](unsigned char c) { return (char)std::tolower(c); });
            return s;
        }

        static bool EndsWith(const std::string& s, const std::string& suffix) {
            if (s.size() < suffix.size()) return false;
            return s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
        }

        static bool ParseIPv4(const std::string& ip, uint32_t* outHostOrder) {
            if (!outHostOrder) return false;
            uint32_t parts[4] = {0, 0, 0, 0};
            size_t start = 0;
            for (int i = 0; i < 4; i++) {
                size_t end = ip.find('.', start);
                if (end == std::string::npos && i != 3) return false;
                std::string token = (end == std::string::npos) ? ip.substr(start) : ip.substr(start, end - start);
                if (token.empty() || token.size() > 3) return false;
                for (char c : token) if (!std::isdigit((unsigned char)c)) return false;
                int value = std::stoi(token);
                if (value < 0 || value > 255) return false;
                parts[i] = static_cast<uint32_t>(value);
                if (end == std::string::npos) break;
                start = end + 1;
            }
            *outHostOrder = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
            return true;
        }

        static bool ParseIPv6(const std::string& ip, std::array<uint8_t, 16>* out) {
            if (!out) return false;
            std::array<uint16_t, 8> words{};
            int wordIndex = 0;
            int compressIndex = -1;

            auto pushWord = [&](const std::string& part) -> bool {
                if (part.empty() || part.size() > 4) return false;
                uint16_t value = 0;
                for (char c : part) {
                    value <<= 4;
                    if (c >= '0' && c <= '9') value |= (c - '0');
                    else if (c >= 'a' && c <= 'f') value |= (c - 'a' + 10);
                    else if (c >= 'A' && c <= 'F') value |= (c - 'A' + 10);
                    else return false;
                }
                if (wordIndex >= 8) return false;
                words[wordIndex++] = value;
                return true;
            };

            size_t i = 0;
            while (i < ip.size()) {
                if (ip[i] == ':') {
                    if (i + 1 < ip.size() && ip[i + 1] == ':') {
                        if (compressIndex != -1) return false;
                        compressIndex = wordIndex;
                        i += 2;
                        if (i >= ip.size()) break;
                        continue;
                    }
                    i++;
                    continue;
                }
                size_t next = ip.find(':', i);
                std::string part = (next == std::string::npos) ? ip.substr(i) : ip.substr(i, next - i);
                if (!pushWord(part)) return false;
                if (next == std::string::npos) break;
                i = next + 1;
            }

            if (compressIndex != -1) {
                int toInsert = 8 - wordIndex;
                for (int j = wordIndex - 1; j >= compressIndex; j--) {
                    words[j + toInsert] = words[j];
                }
                for (int j = 0; j < toInsert; j++) {
                    words[compressIndex + j] = 0;
                }
                wordIndex = 8;
            }

            if (wordIndex != 8) return false;
            for (int k = 0; k < 8; k++) {
                (*out)[k * 2] = static_cast<uint8_t>(words[k] >> 8);
                (*out)[k * 2 + 1] = static_cast<uint8_t>(words[k] & 0xff);
            }
            return true;
        }

        static bool ParseCidrV4(const std::string& cidr, CidrRuleV4* out) {
            if (!out) return false;
            size_t slashPos = cidr.find('/');
            if (slashPos == std::string::npos) return false;
            std::string ipPart = cidr.substr(0, slashPos);
            std::string bitsPart = cidr.substr(slashPos + 1);
            if (bitsPart.empty()) return false;
            for (char c : bitsPart) if (!std::isdigit((unsigned char)c)) return false;
            int bits = std::stoi(bitsPart);
            if (bits < 0 || bits > 32) return false;
            uint32_t ip = 0;
            if (!ParseIPv4(ipPart, &ip)) return false;
            uint32_t mask = (bits == 0) ? 0 : (0xFFFFFFFFu << (32 - bits));
            out->mask = mask;
            out->network = ip & mask;
            return true;
        }

        static bool ParseCidrV6(const std::string& cidr, CidrRuleV6* out) {
            if (!out) return false;
            size_t slashPos = cidr.find('/');
            if (slashPos == std::string::npos) return false;
            std::string ipPart = cidr.substr(0, slashPos);
            std::string bitsPart = cidr.substr(slashPos + 1);
            if (bitsPart.empty()) return false;
            for (char c : bitsPart) if (!std::isdigit((unsigned char)c)) return false;
            int bits = std::stoi(bitsPart);
            if (bits < 0 || bits > 128) return false;
            std::array<uint8_t, 16> addr{};
            if (!ParseIPv6(ipPart, &addr)) return false;
            out->network = addr;
            out->prefix = bits;
            if (bits == 0) {
                for (int i = 0; i < 16; i++) out->network[i] = 0;
            } else if (bits < 128) {
                int fullBytes = bits / 8;
                int rem = bits % 8;
                if (fullBytes < 16) {
                    uint8_t mask = (rem == 0) ? 0 : (uint8_t)(0xFF << (8 - rem));
                    out->network[fullBytes] &= mask;
                    for (int i = fullBytes + 1; i < 16; i++) out->network[i] = 0;
                }
            }
            return true;
        }

        static bool MatchCidrV4(uint32_t ipHostOrder, const CidrRuleV4& rule) {
            return (ipHostOrder & rule.mask) == rule.network;
        }

        static bool MatchCidrV6(const std::array<uint8_t, 16>& ip, const CidrRuleV6& rule) {
            int bits = rule.prefix;
            int fullBytes = bits / 8;
            int rem = bits % 8;
            for (int i = 0; i < fullBytes; i++) {
                if (ip[i] != rule.network[i]) return false;
            }
            if (rem == 0) return true;
            uint8_t mask = (uint8_t)(0xFF << (8 - rem));
            return (ip[fullBytes] & mask) == (rule.network[fullBytes] & mask);
        }

        static bool GlobMatch(const std::string& pattern, const std::string& text) {
            size_t p = 0, t = 0, star = std::string::npos, match = 0;
            while (t < text.size()) {
                if (p < pattern.size() && (pattern[p] == '?' || pattern[p] == text[t])) {
                    p++;
                    t++;
                } else if (p < pattern.size() && pattern[p] == '*') {
                    star = p++;
                    match = t;
                } else if (star != std::string::npos) {
                    p = star + 1;
                    t = ++match;
                } else {
                    return false;
                }
            }
            while (p < pattern.size() && pattern[p] == '*') p++;
            return p == pattern.size();
        }

        static bool MatchDomainPattern(const std::string& pattern, const std::string& host) {
            if (pattern.empty() || host.empty()) return false;
            std::string p = ToLower(pattern);
            std::string h = ToLower(host);

            // 去掉末尾的点
            if (!h.empty() && h.back() == '.') h.pop_back();

            const bool hasWildcard = (p.find('*') != std::string::npos) || (p.find('?') != std::string::npos);
            if (!hasWildcard && !p.empty() && p[0] == '.') {
                std::string root = p.substr(1);
                if (h == root) return true;
                return EndsWith(h, p);
            }
            if (!hasWildcard) return h == p;
            return GlobMatch(p, h);
        }

        static bool ParsePortRange(const std::string& token, PortRange* out) {
            if (!out) return false;
            std::string t;
            for (char c : token) {
                if (!std::isspace((unsigned char)c)) t.push_back(c);
            }
            if (t.empty()) return false;
            size_t dash = t.find('-');
            if (dash == std::string::npos) {
                for (char c : t) if (!std::isdigit((unsigned char)c)) return false;
                int v = std::stoi(t);
                if (v < 0 || v > 65535) return false;
                out->start = static_cast<uint16_t>(v);
                out->end = static_cast<uint16_t>(v);
                return true;
            }
            std::string a = t.substr(0, dash);
            std::string b = t.substr(dash + 1);
            if (a.empty() || b.empty()) return false;
            for (char c : a) if (!std::isdigit((unsigned char)c)) return false;
            for (char c : b) if (!std::isdigit((unsigned char)c)) return false;
            int va = std::stoi(a);
            int vb = std::stoi(b);
            if (va < 0 || va > 65535 || vb < 0 || vb > 65535) return false;
            if (va > vb) std::swap(va, vb);
            out->start = static_cast<uint16_t>(va);
            out->end = static_cast<uint16_t>(vb);
            return true;
        }

        static bool MatchPort(uint16_t port, const std::vector<PortRange>& ranges) {
            if (ranges.empty()) return true;
            if (port == 0) return false;
            for (const auto& r : ranges) {
                if (port >= r.start && port <= r.end) return true;
            }
            return false;
        }

        static bool MatchProtocol(const char* protocol, const std::vector<std::string>& protocols) {
            if (protocols.empty()) return true;
            std::string p = protocol ? ToLower(protocol) : "";
            for (const auto& proto : protocols) {
                if (p == proto) return true;
            }
            return false;
        }

        void CompileRoutingRules() {
            compiled_rules.clear();
            compiled_order.clear();

            std::vector<RoutingRule> srcRules = routing.rules;
            if (routing.use_default_private) {
                RoutingRule def;
                def.name = "default-private";
                def.action = "direct";
                def.ip_cidrs_v4 = {
                    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                    "127.0.0.0/8", "169.254.0.0/16"
                };
                def.ip_cidrs_v6 = {
                    "fc00::/7", "fe80::/10", "::1/128"
                };
                def.protocols = {"tcp"};
                srcRules.insert(srcRules.begin(), def);
            }

            for (const auto& rule : srcRules) {
                CompiledRoutingRule cr{};
                cr.raw = rule;
                cr.raw.action = ToLower(cr.raw.action);
                cr.raw.name = cr.raw.name.empty() ? "(unnamed)" : cr.raw.name;
                if (!cr.raw.action.empty() && cr.raw.action != "proxy" && cr.raw.action != "direct") {
                    Logger::Warn("路由规则: action 无效(" + cr.raw.action + "), rule=" + cr.raw.name);
                    cr.raw.action = routing.default_action;
                }

                for (const auto& cidr : rule.ip_cidrs_v4) {
                    CidrRuleV4 r{};
                    if (ParseCidrV4(cidr, &r)) {
                        cr.v4.push_back(r);
                    } else {
                        Logger::Warn("路由规则: IPv4 CIDR 无效(" + cidr + "), rule=" + cr.raw.name);
                    }
                }
                for (const auto& cidr : rule.ip_cidrs_v6) {
                    CidrRuleV6 r{};
                    if (ParseCidrV6(cidr, &r)) {
                        cr.v6.push_back(r);
                    } else {
                        Logger::Warn("路由规则: IPv6 CIDR 无效(" + cidr + "), rule=" + cr.raw.name);
                    }
                }
                for (const auto& d : rule.domains) {
                    std::string norm = ToLower(d);
                    if (!norm.empty()) cr.domains.push_back(norm);
                }
                for (const auto& p : rule.ports) {
                    PortRange pr{};
                    if (ParsePortRange(p, &pr)) {
                        cr.port_ranges.push_back(pr);
                    } else {
                        Logger::Warn("路由规则: 端口范围无效(" + p + "), rule=" + cr.raw.name);
                    }
                }
                for (const auto& proto : rule.protocols) {
                    std::string norm = ToLower(proto);
                    if (!norm.empty()) cr.protocols.push_back(norm);
                }

                compiled_rules.push_back(cr);
            }

            const bool useNumber = (ToLower(routing.priority_mode) == "number");
            compiled_order.resize(compiled_rules.size());
            for (size_t i = 0; i < compiled_order.size(); i++) compiled_order[i] = i;
            if (useNumber) {
                std::stable_sort(compiled_order.begin(), compiled_order.end(),
                    [&](size_t a, size_t b) {
                        return compiled_rules[a].raw.priority > compiled_rules[b].raw.priority;
                    });
            }
        }

        bool MatchRouting(const std::string& host, const std::string& ip, bool ipIsV6, uint16_t port,
                          const char* protocol, std::string* outAction, std::string* outRule) const {
            if (!routing.enabled) return false;
            std::string action = ToLower(routing.default_action);
            if (action != "proxy" && action != "direct") {
                action = "proxy";
            }

            std::string ipStr = ip;
            std::string hostStr = host;
            if (!hostStr.empty() && hostStr.back() == '.') hostStr.pop_back();

            const bool hasHost = !hostStr.empty();
            const bool hasIp = !ipStr.empty();

            std::array<uint8_t, 16> ip6{};
            uint32_t ip4 = 0;
            bool ip4Valid = false;
            bool ip6Valid = false;
            if (hasIp) {
                if (ipIsV6) {
                    ip6Valid = ParseIPv6(ipStr, &ip6);
                } else {
                    ip4Valid = ParseIPv4(ipStr, &ip4);
                }
            } else if (!hostStr.empty()) {
                // host 可能是 IP 字面量
                ip4Valid = ParseIPv4(hostStr, &ip4);
                ip6Valid = !ip4Valid && ParseIPv6(hostStr, &ip6);
            }

            for (size_t idx : compiled_order) {
                const auto& rule = compiled_rules[idx];
                if (!rule.raw.enabled) continue;
                if (!MatchProtocol(protocol, rule.protocols)) continue;
                if (!MatchPort(port, rule.port_ranges)) continue;

                bool matched = false;
                if (hasHost && !rule.domains.empty()) {
                    for (const auto& pattern : rule.domains) {
                        if (MatchDomainPattern(pattern, hostStr)) {
                            matched = true;
                            break;
                        }
                    }
                }
                if (!matched && ip4Valid && !rule.v4.empty()) {
                    for (const auto& r : rule.v4) {
                        if (MatchCidrV4(ip4, r)) {
                            matched = true;
                            break;
                        }
                    }
                }
                if (!matched && ip6Valid && !rule.v6.empty()) {
                    for (const auto& r : rule.v6) {
                        if (MatchCidrV6(ip6, r)) {
                            matched = true;
                            break;
                        }
                    }
                }

                if (matched) {
                    if (outAction) *outAction = rule.raw.action.empty() ? action : rule.raw.action;
                    if (outRule) *outRule = rule.raw.name;
                    return true;
                }
            }

            if (outAction) *outAction = action;
            if (outRule) *outRule = "";
            return false;
        }
    };

    class Config {
    private:
        // 判断路径是否为绝对路径（Windows 盘符或 UNC 路径）
        static bool IsAbsolutePath(const std::string& path) {
            if (path.size() >= 2 && std::isalpha(static_cast<unsigned char>(path[0])) && path[1] == ':') {
                return true;
            }
            if (path.size() >= 2 &&
                ((path[0] == '\\' && path[1] == '\\') || (path[0] == '/' && path[1] == '/'))) {
                return true;
            }
            return false;
        }

        // 获取当前 DLL 所在目录（用于定位与 DLL 同目录的配置文件）
        static std::string GetModuleDirectory() {
            char modulePath[MAX_PATH] = {0};
            HMODULE hModule = NULL;
            if (!GetModuleHandleExA(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                reinterpret_cast<LPCSTR>(&GetModuleDirectory),
                &hModule
            )) {
                return "";
            }
            DWORD len = GetModuleFileNameA(hModule, modulePath, MAX_PATH);
            if (len == 0 || len >= MAX_PATH) {
                return "";
            }
            for (int i = static_cast<int>(len) - 1; i >= 0; --i) {
                if (modulePath[i] == '\\' || modulePath[i] == '/') {
                    modulePath[i] = '\0';
                    break;
                }
            }
            return std::string(modulePath);
        }

    public:
        ProxyConfig proxy;
        FakeIPConfig fakeIp;
        TimeoutConfig timeout;
        ProxyRules rules;               // 代理路由规则
        bool trafficLogging = false;    // Phase 3: 是否启用流量监控日志
        bool childInjection = true;     // Phase 2: 是否自动注入子进程
        std::vector<std::string> targetProcesses; // 目标进程列表 (空=全部)

        // 检查进程名是否在目标列表中 (大小写不敏感)
        bool ShouldInject(const std::string& processName) const {
            // 如果列表为空，注入所有进程
            if (targetProcesses.empty()) return true;
            
            // 将输入转为小写进行比较
            std::string lowerName = processName;
            std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), 
                [](unsigned char c) { return std::tolower(c); });
            
            for (const auto& target : targetProcesses) {
                std::string lowerTarget = target;
                std::transform(lowerTarget.begin(), lowerTarget.end(), lowerTarget.begin(),
                    [](unsigned char c) { return std::tolower(c); });
                
                // 支持完全匹配或不带扩展名匹配
                if (lowerName == lowerTarget) return true;
                // 支持类似 "language_server_windows" 匹配 "language_server_windows.exe"
                if (lowerName.find(lowerTarget) != std::string::npos) return true;
            }
            return false;
        }

        static Config& Instance() {
            static Config instance;
            return instance;
        }

        bool Load(const std::string& path = "config.json") {
            try {
                // 优先从 DLL 所在目录读取配置，避免子进程工作目录不同导致相对路径失效
                std::vector<std::string> candidates;
                if (IsAbsolutePath(path)) {
                    candidates.push_back(path);
                } else {
                    std::string dllDir = GetModuleDirectory();
                    if (!dllDir.empty()) {
                        candidates.push_back(dllDir + "\\" + path);
                    }
                    candidates.push_back(path);
                }

                std::ifstream f;
                std::string resolvedPath;
                for (const auto& candidate : candidates) {
                    f.open(candidate);
                    if (f.is_open()) {
                        resolvedPath = candidate;
                        break;
                    }
                    f.clear();
                }

                if (!f.is_open()) {
                    if (IsAbsolutePath(path)) {
                        Logger::Error("打开配置文件失败: " + path);
                    } else {
                        Logger::Error("打开配置文件失败: " + path + " (已尝试 DLL 目录与当前目录)");
                    }
                    return false;
                }
                nlohmann::json j = nlohmann::json::parse(f);

                // 日志等级：默认 info（更克制），允许通过配置切到 debug 以获得更细粒度排障信息
                // 设计意图：默认减少刷屏/IO 开销，现场需要时可提升日志粒度。
                const std::string logLevelStr = j.value("log_level", "info");
                if (!Logger::SetLevelFromString(logLevelStr)) {
                    Logger::SetLevel(LogLevel::Info);
                    Logger::Warn("配置: log_level 无效(" + logLevelStr + ")，已回退为 info (可选: debug/info/warn/error)");
                }
                if (!resolvedPath.empty()) {
                    Logger::Info("使用配置文件路径: " + resolvedPath);
                }
                
                if (j.contains("proxy")) {
                    auto& p = j["proxy"];
                    proxy.host = p.value("host", "127.0.0.1");
                    proxy.port = p.value("port", 7890);
                    proxy.type = p.value("type", "socks5");
                }

                // 配置校验：统一 proxy.type 大小写，并对关键字段做防御性修正，避免运行期异常
                std::transform(proxy.type.begin(), proxy.type.end(), proxy.type.begin(),
                               [](unsigned char c) { return (char)std::tolower(c); });
                if (proxy.type.empty()) proxy.type = "socks5";
                if (proxy.type != "socks5" && proxy.type != "http") {
                    Logger::Warn("配置: proxy.type 无效(" + proxy.type + ")，已回退为 socks5 (可选: socks5/http)");
                    proxy.type = "socks5";
                }
                if (proxy.host.empty()) {
                    Logger::Warn("配置: proxy.host 为空，已回退为 127.0.0.1");
                    proxy.host = "127.0.0.1";
                }
                if (proxy.port < 0 || proxy.port > 65535) {
                    Logger::Warn("配置: proxy.port 超出范围(" + std::to_string(proxy.port) + ")，已回退为 7890");
                    proxy.port = 7890;
                }

                if (j.contains("fake_ip")) {
                    auto& fip = j["fake_ip"];
                    fakeIp.enabled = fip.value("enabled", true);
                    fakeIp.cidr = fip.value("cidr", "198.18.0.0/15");
                    // max_entries 已废弃，Ring Buffer 策略下无需配置上限
                }

                if (j.contains("timeout")) {
                    auto& t = j["timeout"];
                    timeout.connect_ms = t.value("connect", 5000);
                    timeout.send_ms = t.value("send", 5000);
                    timeout.recv_ms = t.value("recv", 5000);
                }

                // 配置校验：超时必须为正数，避免 select/WaitConnect 异常行为
                if (timeout.connect_ms <= 0) {
                    Logger::Warn("配置: timeout.connect 非法(" + std::to_string(timeout.connect_ms) + ")，已回退为 5000");
                    timeout.connect_ms = 5000;
                }
                if (timeout.send_ms <= 0) {
                    Logger::Warn("配置: timeout.send 非法(" + std::to_string(timeout.send_ms) + ")，已回退为 5000");
                    timeout.send_ms = 5000;
                }
                if (timeout.recv_ms <= 0) {
                    Logger::Warn("配置: timeout.recv 非法(" + std::to_string(timeout.recv_ms) + ")，已回退为 5000");
                    timeout.recv_ms = 5000;
                }

                // ============= 代理路由规则解析 =============
                bool hasProxyRules = false;
                if (j.contains("proxy_rules")) {
                    hasProxyRules = true;
                    auto& pr = j["proxy_rules"];
                    // 解析端口白名单
                    if (pr.contains("allowed_ports") && pr["allowed_ports"].is_array()) {
                        rules.allowed_ports.clear();
                        for (const auto& p : pr["allowed_ports"]) {
                            if (p.is_number_unsigned()) {
                                rules.allowed_ports.push_back(static_cast<uint16_t>(p.get<unsigned int>()));
                            }
                        }
                    }
                    // 解析 DNS 策略
                    rules.dns_mode = pr.value("dns_mode", "direct");
                    std::transform(rules.dns_mode.begin(), rules.dns_mode.end(),
                                   rules.dns_mode.begin(),
                                   [](unsigned char c) { return (char)std::tolower(c); });
                    if (rules.dns_mode.empty()) rules.dns_mode = "direct";
                    // 解析 IPv6 策略，统一为小写，避免大小写导致配置失效
                    rules.ipv6_mode = pr.value("ipv6_mode", "proxy");
                    std::transform(rules.ipv6_mode.begin(), rules.ipv6_mode.end(),
                                   rules.ipv6_mode.begin(),
                                   [](unsigned char c) { return (char)std::tolower(c); });
                    if (rules.ipv6_mode.empty()) rules.ipv6_mode = "proxy";
                    // 解析 UDP 策略，统一为小写，避免大小写导致配置失效
                    rules.udp_mode = pr.value("udp_mode", "block");
                    std::transform(rules.udp_mode.begin(), rules.udp_mode.end(),
                                   rules.udp_mode.begin(),
                                   [](unsigned char c) { return (char)std::tolower(c); });
                    if (rules.udp_mode.empty()) rules.udp_mode = "block";

                    // 解析 routing 规则
                    if (pr.contains("routing") && pr["routing"].is_object()) {
                        auto& rt = pr["routing"];
                        rules.routing.enabled = rt.value("enabled", true);
                        rules.routing.priority_mode = rt.value("priority_mode", "order");
                        rules.routing.default_action = rt.value("default_action", "proxy");
                        rules.routing.use_default_private = rt.value("use_default_private", true);

                        rules.routing.rules.clear();
                        if (rt.contains("rules") && rt["rules"].is_array()) {
                            for (const auto& item : rt["rules"]) {
                                if (!item.is_object()) continue;
                                RoutingRule rr;
                                rr.name = item.value("name", "");
                                rr.enabled = item.value("enabled", true);
                                rr.action = item.value("action", "proxy");
                                rr.priority = item.value("priority", 0);
                                if (item.contains("ip_cidrs_v4") && item["ip_cidrs_v4"].is_array()) {
                                    for (const auto& v : item["ip_cidrs_v4"]) {
                                        if (v.is_string()) rr.ip_cidrs_v4.push_back(v.get<std::string>());
                                    }
                                }
                                if (item.contains("ip_cidrs_v6") && item["ip_cidrs_v6"].is_array()) {
                                    for (const auto& v : item["ip_cidrs_v6"]) {
                                        if (v.is_string()) rr.ip_cidrs_v6.push_back(v.get<std::string>());
                                    }
                                }
                                if (item.contains("domains") && item["domains"].is_array()) {
                                    for (const auto& v : item["domains"]) {
                                        if (v.is_string()) rr.domains.push_back(v.get<std::string>());
                                    }
                                }
                                if (item.contains("ports") && item["ports"].is_array()) {
                                    for (const auto& v : item["ports"]) {
                                        if (v.is_string()) rr.ports.push_back(v.get<std::string>());
                                    }
                                }
                                if (item.contains("protocols") && item["protocols"].is_array()) {
                                    for (const auto& v : item["protocols"]) {
                                        if (v.is_string()) rr.protocols.push_back(v.get<std::string>());
                                    }
                                }
                                rules.routing.rules.push_back(rr);
                            }
                        }
                    }
                }
                // 配置校验：限制策略枚举取值，避免拼写错误导致绕过预期逻辑
                if (rules.dns_mode != "direct" && rules.dns_mode != "proxy") {
                    Logger::Warn("配置: proxy_rules.dns_mode 无效(" + rules.dns_mode + ")，已回退为 direct (可选: direct/proxy)");
                    rules.dns_mode = "direct";
                }
                if (rules.ipv6_mode != "proxy" && rules.ipv6_mode != "direct" && rules.ipv6_mode != "block") {
                    Logger::Warn("配置: proxy_rules.ipv6_mode 无效(" + rules.ipv6_mode + ")，已回退为 proxy (可选: proxy/direct/block)");
                    rules.ipv6_mode = "proxy";
                }
                if (rules.udp_mode != "block" && rules.udp_mode != "direct") {
                    Logger::Warn("配置: proxy_rules.udp_mode 无效(" + rules.udp_mode + ")，已回退为 block (可选: block/direct)");
                    rules.udp_mode = "block";
                }
                rules.routing.priority_mode = ProxyRules::ToLower(rules.routing.priority_mode);
                if (rules.routing.priority_mode != "order" && rules.routing.priority_mode != "number") {
                    Logger::Warn("配置: proxy_rules.routing.priority_mode 无效(" + rules.routing.priority_mode + ")，已回退为 order (可选: order/number)");
                    rules.routing.priority_mode = "order";
                }
                rules.routing.default_action = ProxyRules::ToLower(rules.routing.default_action);
                if (rules.routing.default_action != "proxy" && rules.routing.default_action != "direct") {
                    Logger::Warn("配置: proxy_rules.routing.default_action 无效(" + rules.routing.default_action + ")，已回退为 proxy (可选: proxy/direct)");
                    rules.routing.default_action = "proxy";
                }

                Logger::Info("路由规则: allowed_ports=" + std::to_string(rules.allowed_ports.size()) +
                             " 项, dns_mode=" + rules.dns_mode + ", ipv6_mode=" + rules.ipv6_mode +
                             ", udp_mode=" + rules.udp_mode +
                             ", routing=" + std::string(rules.routing.enabled ? "on" : "off") +
                             ", routing_rules=" + std::to_string(rules.routing.rules.size()) +
                             (hasProxyRules ? "" : " (默认)"));

                rules.CompileRoutingRules();


                // Phase 2/3 配置项
                trafficLogging = j.value("traffic_logging", false);
                childInjection = j.value("child_injection", true);

                // 目标进程列表
                if (j.contains("target_processes") && j["target_processes"].is_array()) {
                    targetProcesses.clear();
                    for (const auto& item : j["target_processes"]) {
                        if (item.is_string()) {
                            targetProcesses.push_back(item.get<std::string>());
                        }
                    }
                    Logger::Info("已加载目标进程列表, 共 " + std::to_string(targetProcesses.size()) + " 项");
                }

                Logger::Info("配置: proxy=" + proxy.host + ":" + std::to_string(proxy.port) +
                             " type=" + proxy.type +
                             ", fake_ip=" + std::string(fakeIp.enabled ? "true" : "false") +
                             ", child_injection=" + std::string(childInjection ? "true" : "false") +
                             ", traffic_logging=" + std::string(trafficLogging ? "true" : "false"));
                Logger::Info("配置加载成功。");
                return true;
            } catch (const std::exception& e) {
                Logger::Error(std::string("配置解析失败: ") + e.what());
                return false;
            }
        }
    };
}
