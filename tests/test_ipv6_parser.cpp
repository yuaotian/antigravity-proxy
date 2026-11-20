// 回归测试在 Release 构建下也必须执行断言。
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <array>
#include <string>

#include "core/Config.hpp"

static bool MatchCidrV6(const std::string& ip, const std::string& cidr) {
    Core::ProxyRules::CidrRuleV6 rule{};
    if (!Core::ProxyRules::ParseCidrV6(cidr, &rule)) return false;
    std::array<uint8_t, 16> addr{};
    if (!Core::ProxyRules::ParseIPv6(ip, &addr)) return false;
    return Core::ProxyRules::MatchCidrV6(addr, rule);
}

int main() {
    std::array<uint8_t, 16> out{};

    // 基础解析：:: 压缩（开头/中间/结尾）
    assert(Core::ProxyRules::ParseIPv6("::", &out));
    for (auto b : out) assert(b == 0);
    assert(Core::ProxyRules::ParseIPv6("::1", &out));
    assert(out[15] == 1);
    assert(Core::ProxyRules::ParseIPv6("2001:db8::1", &out));
    assert(Core::ProxyRules::ParseIPv6("fc00::", &out));
    assert(Core::ProxyRules::ParseIPv6("FC00::", &out)); // 大小写兼容

    // 默认私网 IPv6 CIDR：应能被正确解析与匹配
    assert(MatchCidrV6("fc00::1", "fc00::/7"));
    assert(MatchCidrV6("fd00::1", "fc00::/7"));
    assert(!MatchCidrV6("fe00::1", "fc00::/7"));

    assert(MatchCidrV6("fe80::1", "fe80::/10"));
    assert(!MatchCidrV6("fec0::1", "fe80::/10"));

    assert(MatchCidrV6("::1", "::1/128"));
    assert(!MatchCidrV6("::2", "::1/128"));

    // 常见测试网段
    assert(MatchCidrV6("2001:db8::1", "2001:db8::1/128"));
    assert(MatchCidrV6("1234:5678:9abc:def0:1111:2222:3333:4444", "::/0"));

    // IPv4-embedded IPv6（v4-mapped）
    assert(Core::ProxyRules::ParseIPv6("::ffff:192.0.2.128", &out));

    // 非法格式
    assert(!Core::ProxyRules::ParseIPv6("2001:::1", &out));
    assert(!Core::ProxyRules::ParseIPv6("gggg::1", &out));

    // Issue #169：内置 default-private 规则同时作用于 UDP（局域网 UDP 直连；udp_mode=block 时据此放行）
    {
        Core::ProxyRules rules;
        rules.CompileRoutingRules();
        std::string action;
        assert(rules.MatchRouting("", "192.168.1.5", false, 3478, "udp", &action, nullptr) && action == "direct");
        assert(rules.MatchRouting("", "fe80::1", true, 50000, "udp", &action, nullptr) && action == "direct");
        // TCP 行为保持不变
        assert(rules.MatchRouting("", "10.0.0.8", false, 443, "tcp", &action, nullptr) && action == "direct");
        // 公网地址不命中内置规则：block 模式下仍被阻断
        assert(!rules.MatchRouting("", "74.125.247.128", false, 3478, "udp", &action, nullptr));
    }

    return 0;
}

