// 回归测试在 Release 构建下也必须执行断言。
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <string>

#include "core/Config.hpp"
#include "network/HttpConnect.hpp"
#include "network/Socks5.hpp"

int main() {
    // 1. Base64 编码测试 (RFC 4648 标准测试向量)
    assert(Network::HttpConnectClient::Base64Encode("") == "");
    assert(Network::HttpConnectClient::Base64Encode("f") == "Zg==");
    assert(Network::HttpConnectClient::Base64Encode("fo") == "Zm8=");
    assert(Network::HttpConnectClient::Base64Encode("foo") == "Zm9v");
    assert(Network::HttpConnectClient::Base64Encode("foob") == "Zm9vYg==");
    assert(Network::HttpConnectClient::Base64Encode("fooba") == "Zm9vYmE=");
    assert(Network::HttpConnectClient::Base64Encode("foobar") == "Zm9vYmFy");

    // 常见代理账密格式验证
    assert(Network::HttpConnectClient::Base64Encode("admin:secret123") == "YWRtaW46c2VjcmV0MTIz");
    assert(Network::HttpConnectClient::Base64Encode("user:pass") == "dXNlcjpwYXNz");
    assert(Network::HttpConnectClient::Base64Encode("user:p@$$w0rd#!") == "dXNlcjpwQCQkdzByZCMh");

    // 2. SOCKS5 认证常量测试
    assert(Network::Socks5::VERSION == 0x05);
    assert(Network::Socks5::AUTH_NONE == 0x00);
    assert(Network::Socks5::AUTH_USERPASS == 0x02);

    // 3. ProxyConfig 默认值与字段测试
    Core::ProxyConfig defaultProxy;
    assert(defaultProxy.host == "127.0.0.1");
    assert(defaultProxy.port == 7890);
    assert(defaultProxy.type == "socks5");
    assert(defaultProxy.username.empty());
    assert(defaultProxy.password.empty());

    return 0;
}
