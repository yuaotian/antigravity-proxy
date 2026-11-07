#pragma once
#include <nlohmann/json.hpp>
#include <fstream>
#include <string>
#include <vector>
#include <algorithm>
#include <cctype>
#include <array>
#include <charconv>
#include <system_error>
#include <sstream>
#include <cstdint>
#include <string_view>
#include <utility>
#include "Logger.hpp"
#include "UdpPolicy.hpp"

namespace Core {
    struct ProxyConfig {
        std::string host = "127.0.0.1";
        int port = 7890;
        std::string type = "socks5";
        std::string username;
        std::string password;
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

    struct UpdateConfig {
        // 自动更新检查默认关闭，避免 release 启动后默认访问 GitHub。
        bool enabled = false;
        // 延迟启动后台检查，确保主流程 Hook 加载不被更新检查影响。
        int check_delay_ms = 15000;
        int timeout_ms = 5000;
        bool notify_once = true;
        bool allow_insecure_mirrors = true;
        std::vector<std::string> mirrors = {
            "https://wget.la/",
            "https://rapidgit.jjda.de5.net/",
            "https://fastgit.cc/",
            "https://gitproxy.mrhjx.cn/",
            "https://github.boki.moe/",
            "https://github.ednovas.xyz/"
        };
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
        // "auto"   - SOCKS5 自动走 UDP Associate；其它代理按 udp_fallback 处理（默认）
        // "block"  - 阻断 UDP，强制应用尝试回退 TCP
        // "direct" - UDP 直连（保持现状）
        // "proxy"  - UDP 走代理（需要代理端支持 SOCKS5 UDP Associate；用于 QUIC/HTTP3 等必须 UDP 的协议）
        std::string udp_mode = "auto";

        // UDP 代理失败或 auto 遇到非 SOCKS5 代理时的降级策略
        // "block"  - 失败即阻断（默认，避免 UDP 直连泄漏）
        // "direct" - 失败回退直连（风险更高，但可用于“代理不支持 UDP”时的兼容模式）
        std::string udp_fallback = "block";

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

        // 编译统计（用于启动日志摘要，便于快速判断规则是否生效）
        size_t compiled_valid_cidr_v4 = 0;
        size_t compiled_valid_cidr_v6 = 0;
        size_t compiled_valid_port_ranges = 0;
        size_t compiled_skipped_invalid_items = 0;
        size_t compiled_skipped_invalid_cidr_v4 = 0;
        size_t compiled_skipped_invalid_cidr_v6 = 0;
        size_t compiled_skipped_invalid_ports = 0;

        // 快速判断端口是否在白名单中
        bool IsPortAllowed(uint16_t port) const {
            if (allowed_ports.empty()) return true; // 空白名单 = 允许所有
            // 约定：Load() 后会对 allowed_ports 排序去重，这里用 binary_search 提升热路径性能
            return std::binary_search(allowed_ports.begin(), allowed_ports.end(), port);
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

        // 去除首尾空白（仅用于配置解析；运行时热路径尽量避免额外分配）
        static std::string_view TrimView(std::string_view s) {
            while (!s.empty() && std::isspace((unsigned char)s.front())) s.remove_prefix(1);
            while (!s.empty() && std::isspace((unsigned char)s.back())) s.remove_suffix(1);
            return s;
        }

        // 安全整数解析：不抛异常，失败返回 false
        static bool TryParseUInt32(std::string_view s, uint32_t* out, int base = 10) {
            if (!out) return false;
            s = TrimView(s);
            if (s.empty()) return false;
            uint32_t v = 0;
            const char* begin = s.data();
            const char* end = s.data() + s.size();
            auto rc = std::from_chars(begin, end, v, base);
            if (rc.ec != std::errc() || rc.ptr != end) return false;
            *out = v;
            return true;
        }

        static bool ParseIPv4View(std::string_view ip, uint32_t* outHostOrder) {
            if (!outHostOrder) return false;
            ip = TrimView(ip);
            uint32_t parts[4] = {0, 0, 0, 0};
            size_t start = 0;
            for (int i = 0; i < 4; i++) {
                size_t end = ip.find('.', start);
                if (end == std::string_view::npos && i != 3) return false;
                std::string_view token = (end == std::string_view::npos) ? ip.substr(start)
                                                                         : ip.substr(start, end - start);
                token = TrimView(token);
                if (token.empty() || token.size() > 3) return false;
                uint32_t value = 0;
                if (!TryParseUInt32(token, &value, 10)) return false;
                if (value > 255) return false;
                parts[i] = value;
                if (end == std::string_view::npos) break;
                start = end + 1;
            }
            *outHostOrder = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
            return true;
        }

        static bool ParseIPv4(const std::string& ip, uint32_t* outHostOrder) {
            return ParseIPv4View(ip, outHostOrder);
        }

        static bool ParseIPv6(const std::string& ip, std::array<uint8_t, 16>* out) {
            if (!out) return false;
            std::string_view s = TrimView(ip);
            if (s.empty()) return false;

            auto parseHexWord = [&](std::string_view part, uint16_t* outWord) -> bool {
                if (!outWord) return false;
                part = TrimView(part);
                if (part.empty() || part.size() > 4) return false;
                uint32_t tmp = 0;
                if (!TryParseUInt32(part, &tmp, 16)) return false;
                if (tmp > 0xFFFF) return false;
                *outWord = (uint16_t)tmp;
                return true;
            };

            auto parseSide = [&](std::string_view side, std::array<uint16_t, 8>* outWords, int* outCount) -> bool {
                if (!outWords || !outCount) return false;
                *outCount = 0;
                if (side.empty()) return true;
                size_t start = 0;
                while (start <= side.size()) {
                    size_t end = side.find(':', start);
                    std::string_view token = (end == std::string_view::npos) ? side.substr(start)
                                                                             : side.substr(start, end - start);
                    if (token.empty()) return false; // 不允许出现单独的 ':'（:: 压缩已在外层处理）
                    if (token.find('.') != std::string_view::npos) {
                        // IPv4-embedded IPv6：仅允许出现在最后一个 token
                        if (end != std::string_view::npos) return false;
                        uint32_t ip4 = 0;
                        if (!ParseIPv4View(token, &ip4)) return false;
                        if (*outCount + 2 > 8) return false;
                        (*outWords)[(*outCount)++] = (uint16_t)((ip4 >> 16) & 0xFFFF);
                        (*outWords)[(*outCount)++] = (uint16_t)(ip4 & 0xFFFF);
                        return true;
                    }
                    uint16_t w = 0;
                    if (!parseHexWord(token, &w)) return false;
                    if (*outCount >= 8) return false;
                    (*outWords)[(*outCount)++] = w;
                    if (end == std::string_view::npos) break;
                    start = end + 1;
                }
                return true;
            };

            std::array<uint16_t, 8> words{};
            const size_t dc = s.find("::");
            if (dc != std::string_view::npos) {
                // 仅允许出现一次 ::
                if (s.find("::", dc + 2) != std::string_view::npos) return false;
                std::array<uint16_t, 8> left{};
                std::array<uint16_t, 8> right{};
                int leftCount = 0;
                int rightCount = 0;
                if (!parseSide(s.substr(0, dc), &left, &leftCount)) return false;
                if (!parseSide(s.substr(dc + 2), &right, &rightCount)) return false;
                if (leftCount + rightCount > 8) return false;
                const int fill = 8 - (leftCount + rightCount);
                if (fill <= 0) return false; // :: 必须至少压缩 1 个 16-bit 段
                int idx = 0;
                for (int i = 0; i < leftCount; i++) words[idx++] = left[i];
                for (int i = 0; i < fill; i++) words[idx++] = 0;
                for (int i = 0; i < rightCount; i++) words[idx++] = right[i];
                if (idx != 8) return false;
            } else {
                int count = 0;
                if (!parseSide(s, &words, &count)) return false;
                if (count != 8) return false;
            }

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
            std::string_view ipPart = TrimView(std::string_view(cidr).substr(0, slashPos));
            std::string_view bitsPart = TrimView(std::string_view(cidr).substr(slashPos + 1));
            if (bitsPart.empty()) return false;
            uint32_t bitsU = 0;
            if (!TryParseUInt32(bitsPart, &bitsU, 10) || bitsU > 32) return false;
            const int bits = (int)bitsU;
            uint32_t ip = 0;
            if (!ParseIPv4View(ipPart, &ip)) return false;
            uint32_t mask = (bits == 0) ? 0 : (0xFFFFFFFFu << (32 - bits));
            out->mask = mask;
            out->network = ip & mask;
            return true;
        }

        static bool ParseCidrV6(const std::string& cidr, CidrRuleV6* out) {
            if (!out) return false;
            size_t slashPos = cidr.find('/');
            if (slashPos == std::string::npos) return false;
            std::string_view ipPart = TrimView(std::string_view(cidr).substr(0, slashPos));
            std::string_view bitsPart = TrimView(std::string_view(cidr).substr(slashPos + 1));
            if (bitsPart.empty()) return false;
            uint32_t bitsU = 0;
            if (!TryParseUInt32(bitsPart, &bitsU, 10) || bitsU > 128) return false;
            const int bits = (int)bitsU;
            std::array<uint8_t, 16> addr{};
            if (!ParseIPv6(std::string(ipPart), &addr)) return false;
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
            // 性能优化：pattern/host 在上层已统一转为小写并去掉末尾 '.'，此处避免重复 ToLower 与分配。
            const std::string& p = pattern;
            const std::string& h = host;

            const bool hasWildcard = (p.find('*') != std::string::npos) || (p.find('?') != std::string::npos);
            if (!hasWildcard && !p.empty() && p[0] == '.') {
                // 规则 ".example.com" 需同时匹配 "example.com" 与 "*.example.com"
                const size_t rootLen = p.size() - 1;
                if (h.size() == rootLen && h.compare(0, rootLen, p, 1, rootLen) == 0) return true;
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
                uint32_t v = 0;
                if (!TryParseUInt32(t, &v, 10) || v > 65535) return false;
                out->start = static_cast<uint16_t>(v);
                out->end = static_cast<uint16_t>(v);
                return true;
            }
            std::string a = t.substr(0, dash);
            std::string b = t.substr(dash + 1);
            if (a.empty() || b.empty()) return false;
            uint32_t va = 0;
            uint32_t vb = 0;
            if (!TryParseUInt32(a, &va, 10) || !TryParseUInt32(b, &vb, 10)) return false;
            if (va > 65535 || vb > 65535) return false;
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
            compiled_valid_cidr_v4 = 0;
            compiled_valid_cidr_v6 = 0;
            compiled_valid_port_ranges = 0;
            compiled_skipped_invalid_items = 0;
            compiled_skipped_invalid_cidr_v4 = 0;
            compiled_skipped_invalid_cidr_v6 = 0;
            compiled_skipped_invalid_ports = 0;

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
                        compiled_valid_cidr_v4++;
                    } else {
                        Logger::Warn("路由规则: IPv4 CIDR 无效(" + cidr + "), rule=" + cr.raw.name);
                        compiled_skipped_invalid_items++;
                        compiled_skipped_invalid_cidr_v4++;
                    }
                }
                for (const auto& cidr : rule.ip_cidrs_v6) {
                    CidrRuleV6 r{};
                    if (ParseCidrV6(cidr, &r)) {
                        cr.v6.push_back(r);
                        compiled_valid_cidr_v6++;
                    } else {
                        Logger::Warn("路由规则: IPv6 CIDR 无效(" + cidr + "), rule=" + cr.raw.name);
                        compiled_skipped_invalid_items++;
                        compiled_skipped_invalid_cidr_v6++;
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
                        compiled_valid_port_ranges++;
                    } else {
                        Logger::Warn("路由规则: 端口范围无效(" + p + "), rule=" + cr.raw.name);
                        compiled_skipped_invalid_items++;
                        compiled_skipped_invalid_ports++;
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
            // 性能优化：域名匹配热路径避免重复 ToLower/分配；统一在此处转为小写
            if (!hostStr.empty()) hostStr = ToLower(std::move(hostStr));

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
        static std::string ToLowerCopy(std::string s) {
            std::transform(s.begin(), s.end(), s.begin(),
                           [](unsigned char c) { return (char)std::tolower(c); });
            return s;
        }

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
        bool diagnosticsAgentIpProbe = false; // 默认关闭外部 IP 探测，降低 release 默认联网行为面
        std::string uiLoadNotify = "once";    // 加载提示策略：once/none/messagebox，默认每个版本成功提示一次
        std::string buildVersion = "0";        // 来自 config.json 的 _version，用于更新检查比较
        UpdateConfig updates;                  // GitHub Release 更新检查配置（默认关闭）
        bool childInjection = true;     // Phase 2: 是否自动注入子进程
        // 子进程注入模式：
        // - "filtered"（默认）：按 target_processes 过滤
        // - "inherit"：注入所有子进程（可通过 child_injection_exclude 排除）
        std::string childInjectionMode = "filtered";
        std::vector<std::string> childInjectionExclude; // 进程排除列表（大小写不敏感，支持子串匹配）
        std::vector<std::string> targetProcesses; // 目标进程列表 (空=全部)

        // 检查进程名是否在目标列表中 (大小写不敏感)
        bool ShouldInject(const std::string& processName) const {
            // 如果列表为空，注入所有进程
            if (targetProcesses.empty()) return true;
            
            // 将输入转为小写进行比较
            std::string lowerName = ToLowerCopy(processName);
            
            for (const auto& target : targetProcesses) {
                std::string lowerTarget = ToLowerCopy(target);
                
                // 支持完全匹配或不带扩展名匹配
                if (lowerName == lowerTarget) return true;
                // 支持类似 "language_server_windows" 匹配 "language_server_windows.exe"
                if (lowerName.find(lowerTarget) != std::string::npos) return true;
            }
            return false;
        }

        bool IsChildInjectionExcluded(const std::string& processName) const {
            if (childInjectionExclude.empty()) return false;
            const std::string lowerName = ToLowerCopy(processName);
            for (const auto& item : childInjectionExclude) {
                const std::string lowerItem = ToLowerCopy(item);
                if (lowerItem.empty()) continue;
                if (lowerName == lowerItem) return true;
                if (lowerName.find(lowerItem) != std::string::npos) return true;
            }
            return false;
        }

        bool ShouldInjectChildProcess(const std::string& processName) const {
            if (IsChildInjectionExcluded(processName)) return false;
            const std::string mode = ToLowerCopy(childInjectionMode);
            if (mode == "inherit") return true;
            // 默认/兜底：按 target_processes 过滤（保持历史行为）
            return ShouldInject(processName);
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
                buildVersion = j.value("_version", "0");

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
                    if (p.contains("username")) proxy.username = p.value("username", "");
                    else if (p.contains("user")) proxy.username = p.value("user", "");
                    if (p.contains("password")) proxy.password = p.value("password", "");
                    else if (p.contains("pass")) proxy.password = p.value("pass", "");
                }

                // 配置校验：统一 proxy.type 大小写，并对关键字段做防御性修正，避免运行期异常
                // 设计意图：容错处理常见的无意空格/大小写问题，减少“配置写对了但实际没生效”的排障成本。
                auto trimInPlace = [](std::string& s) {
                    auto isWs = [](unsigned char c) { return std::isspace(c) != 0; };
                    size_t begin = 0;
                    while (begin < s.size() && isWs((unsigned char)s[begin])) begin++;
                    size_t end = s.size();
                    while (end > begin && isWs((unsigned char)s[end - 1])) end--;
                    if (begin == 0 && end == s.size()) return;
                    s = s.substr(begin, end - begin);
                };
                trimInPlace(buildVersion);
                if (buildVersion.empty()) buildVersion = "0";
                trimInPlace(proxy.type);
                std::transform(proxy.type.begin(), proxy.type.end(), proxy.type.begin(),
                               [](unsigned char c) { return (char)std::tolower(c); });
                if (proxy.type.empty()) proxy.type = "socks5";

                // 兼容用户常见写法：不少人会把 “HTTP 代理(用于 HTTPS 网站的 CONNECT)” 误写成 https。
                // 注意：这里的 https 仅按 HTTP CONNECT 处理，不代表支持“与代理之间使用 TLS 的 HTTPS 代理”。
                if (proxy.type == "https") {
                    Logger::Warn("配置: proxy.type=https 暂不支持 TLS 代理；若你指的是 HTTP 代理(含 CONNECT) 访问 HTTPS 站点，请改为 http。当前已按 http 处理。");
                    proxy.type = "http";
                }
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

                // 可选诊断能力：默认关闭，避免 release 启动后主动访问外部 IP 查询服务。
                if (j.contains("diagnostics") && j["diagnostics"].is_object()) {
                    const auto& diag = j["diagnostics"];
                    diagnosticsAgentIpProbe = diag.value("agent_ip_probe", false);
                }

                // 可选 UI 提示：默认 once；成功仅每个版本提示一次，失败仍会提示便于排障。
                if (j.contains("ui") && j["ui"].is_object()) {
                    const auto& ui = j["ui"];
                    uiLoadNotify = ui.value("load_notify", "once");
                }
                trimInPlace(uiLoadNotify);
                std::transform(uiLoadNotify.begin(), uiLoadNotify.end(), uiLoadNotify.begin(),
                               [](unsigned char c) { return (char)std::tolower(c); });
                if (uiLoadNotify == "message_box") uiLoadNotify = "messagebox";
                if (uiLoadNotify.empty()) uiLoadNotify = "once";
                if (uiLoadNotify != "once" && uiLoadNotify != "none" && uiLoadNotify != "messagebox") {
                    Logger::Warn("配置: ui.load_notify 无效(" + uiLoadNotify + ")，已回退为 once (可选: once/none/messagebox)");
                    uiLoadNotify = "once";
                }

                // GitHub Release 更新检查：默认关闭；仅用户显式开启后才启动后台联网检查。
                if (j.contains("updates") && j["updates"].is_object()) {
                    const auto& upd = j["updates"];
                    updates.enabled = upd.value("enabled", false);
                    updates.check_delay_ms = upd.value("check_delay_ms", 15000);
                    updates.timeout_ms = upd.value("timeout_ms", 5000);
                    updates.notify_once = upd.value("notify_once", true);
                    updates.allow_insecure_mirrors = upd.value("allow_insecure_mirrors", true);
                    if (upd.contains("mirrors") && upd["mirrors"].is_array()) {
                        updates.mirrors.clear();
                        for (const auto& item : upd["mirrors"]) {
                            if (!item.is_string()) continue;
                            std::string mirror = item.get<std::string>();
                            trimInPlace(mirror);
                            if (!mirror.empty()) {
                                updates.mirrors.push_back(mirror);
                            }
                        }
                    }
                }
                if (updates.check_delay_ms < 0) {
                    Logger::Warn("配置: updates.check_delay_ms 非法(" + std::to_string(updates.check_delay_ms) + ")，已回退为 15000");
                    updates.check_delay_ms = 15000;
                }
                if (updates.timeout_ms <= 0) {
                    Logger::Warn("配置: updates.timeout_ms 非法(" + std::to_string(updates.timeout_ms) + ")，已回退为 5000");
                    updates.timeout_ms = 5000;
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
                            // WARN-1: 范围校验，避免 uint16_t 截断导致端口误判
                            long long signedV = 0;
                            unsigned long long unsignedV = 0;
                            bool hasValue = false;
                            if (p.is_number_unsigned()) {
                                unsignedV = p.get<unsigned long long>();
                                hasValue = true;
                            } else if (p.is_number_integer()) {
                                signedV = p.get<long long>();
                                hasValue = true;
                            } else {
                                continue;
                            }
                            unsigned long long v = p.is_number_unsigned()
                                                      ? unsignedV
                                                      : (signedV < 0 ? 0ull : (unsigned long long)signedV);
                            if (!hasValue || v == 0 || v > 65535) {
                                Logger::Warn("配置: proxy_rules.allowed_ports 非法(" + std::to_string(v) + ")，已跳过 (有效范围: 1-65535)");
                                continue;
                            }
                            rules.allowed_ports.push_back(static_cast<uint16_t>(v));
                        }
                        // 去重 + 排序（热路径 binary_search 依赖）
                        std::sort(rules.allowed_ports.begin(), rules.allowed_ports.end());
                        rules.allowed_ports.erase(std::unique(rules.allowed_ports.begin(), rules.allowed_ports.end()),
                                                  rules.allowed_ports.end());
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
                    rules.udp_mode = pr.value("udp_mode", "auto");
                    std::transform(rules.udp_mode.begin(), rules.udp_mode.end(),
                                   rules.udp_mode.begin(),
                                   [](unsigned char c) { return (char)std::tolower(c); });
                    if (rules.udp_mode.empty()) rules.udp_mode = "auto";

                    // 解析 UDP 代理失败降级策略
                    rules.udp_fallback = pr.value("udp_fallback", "block");
                    std::transform(rules.udp_fallback.begin(), rules.udp_fallback.end(),
                                   rules.udp_fallback.begin(),
                                   [](unsigned char c) { return (char)std::tolower(c); });
                    if (rules.udp_fallback.empty()) rules.udp_fallback = "block";

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
                if (rules.udp_mode != "auto" && rules.udp_mode != "block" &&
                    rules.udp_mode != "direct" && rules.udp_mode != "proxy") {
                    Logger::Warn("配置: proxy_rules.udp_mode 无效(" + rules.udp_mode + ")，已回退为 auto (可选: auto/block/direct/proxy)");
                    rules.udp_mode = "auto";
                }
                if (rules.udp_fallback != "block" && rules.udp_fallback != "direct") {
                    Logger::Warn("配置: proxy_rules.udp_fallback 无效(" + rules.udp_fallback + ")，已回退为 block (可选: block/direct)");
                    rules.udp_fallback = "block";
                }
                const UdpAction effectiveUdpAction =
                    ResolveUdpAction(rules.udp_mode, proxy.type, rules.udp_fallback);
                if (rules.udp_mode == "auto" && proxy.type != "socks5") {
                    Logger::Warn("配置: udp_mode=auto 仅在 SOCKS5 下使用 UDP Associate；当前 proxy.type=" +
                                 proxy.type + "，有效策略=" + UdpActionName(effectiveUdpAction));
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
                             ", udp_mode=" + rules.udp_mode + ", udp_fallback=" + rules.udp_fallback +
                             ", udp_effective=" + UdpActionName(effectiveUdpAction) +
                             ", routing=" + std::string(rules.routing.enabled ? "on" : "off") +
                             ", routing_rules=" + std::to_string(rules.routing.rules.size()) +
                             (hasProxyRules ? "" : " (默认)"));

                rules.CompileRoutingRules();


                // Phase 2/3 配置项
                trafficLogging = j.value("traffic_logging", false);
                childInjection = j.value("child_injection", true);
                // 子进程注入模式
                childInjectionMode = j.value("child_injection_mode", childInjectionMode);
                childInjectionMode = ToLowerCopy(childInjectionMode);
                if (childInjectionMode.empty()) childInjectionMode = "filtered";
                if (childInjectionMode != "filtered" && childInjectionMode != "inherit") {
                    Logger::Warn("配置: child_injection_mode 无效(" + childInjectionMode + ")，已回退为 filtered (可选: filtered/inherit)");
                    childInjectionMode = "filtered";
                }
                // 子进程注入排除列表
                childInjectionExclude.clear();
                if (j.contains("child_injection_exclude") && j["child_injection_exclude"].is_array()) {
                    for (const auto& item : j["child_injection_exclude"]) {
                        if (item.is_string()) {
                            childInjectionExclude.push_back(item.get<std::string>());
                        }
                    }
                }

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

                std::string authLog;
                if (!proxy.username.empty() || !proxy.password.empty()) {
                    authLog = ", auth=" + (proxy.username.empty() ? "(none)" : proxy.username) + ":***";
                }
                Logger::Info("配置: proxy=" + proxy.host + ":" + std::to_string(proxy.port) +
                             " type=" + proxy.type +
                             authLog +
                             ", fake_ip=" + std::string(fakeIp.enabled ? "true" : "false") +
                             ", child_injection=" + std::string(childInjection ? "true" : "false") +
                             ", child_injection_mode=" + childInjectionMode +
                             ", child_injection_exclude=" + std::to_string(childInjectionExclude.size()) +
                             ", traffic_logging=" + std::string(trafficLogging ? "true" : "false") +
                             ", diagnostics.agent_ip_probe=" + std::string(diagnosticsAgentIpProbe ? "true" : "false") +
                             ", ui.load_notify=" + uiLoadNotify +
                             ", updates.enabled=" + std::string(updates.enabled ? "true" : "false") +
                             ", updates.delay_ms=" + std::to_string(updates.check_delay_ms) +
                             ", updates.mirrors=" + std::to_string(updates.mirrors.size()));

                // CRIT-1/2/WARN-3: 仅在 Load() 成功返回前输出“有效 CIDR 统计 + 跳过数量”，避免失败时误导
                Logger::Info("路由规则: 编译统计: 有效 IPv4 CIDR=" + std::to_string(rules.compiled_valid_cidr_v4) +
                             ", 有效 IPv6 CIDR 规则数量=" + std::to_string(rules.compiled_valid_cidr_v6) +
                             ", 有效端口范围=" + std::to_string(rules.compiled_valid_port_ranges) +
                             ", 跳过无效项=" + std::to_string(rules.compiled_skipped_invalid_items) +
                             " (v4_cidr=" + std::to_string(rules.compiled_skipped_invalid_cidr_v4) +
                             ", v6_cidr=" + std::to_string(rules.compiled_skipped_invalid_cidr_v6) +
                             ", ports=" + std::to_string(rules.compiled_skipped_invalid_ports) + ")");
                Logger::Info("配置加载成功。");
                return true;
            } catch (const std::exception& e) {
                Logger::Error(std::string("配置解析失败: ") + e.what());
                return false;
            }
        }
    };
}
