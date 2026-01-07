#include <MinHook.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include "../core/Config.hpp"
#include "../core/Logger.hpp"
#include "../network/SocketWrapper.hpp"
#include "../network/FakeIP.hpp"
#include "../network/Socks5.hpp"

// ============= 函数指针类型定义 =============
typedef int (WSAAPI *connect_t)(SOCKET, const struct sockaddr*, int);
typedef int (WSAAPI *WSAConnect_t)(SOCKET, const struct sockaddr*, int, LPWSABUF, LPWSABUF, LPQOS, LPQOS);
typedef int (WSAAPI *getaddrinfo_t)(PCSTR, PCSTR, const ADDRINFOA*, PADDRINFOA*);

// ============= 原始函数指针 =============
connect_t fpConnect = NULL;
WSAConnect_t fpWSAConnect = NULL;
getaddrinfo_t fpGetAddrInfo = NULL;

// ============= 辅助函数 =============

// 保存原始目标地址用于 SOCKS5 握手
struct OriginalTarget {
    std::string host;
    uint16_t port;
};

// 线程本地存储，保存当前连接的原始目标
thread_local OriginalTarget g_currentTarget;

// 执行代理连接逻辑
int PerformProxyConnect(SOCKET s, const struct sockaddr* name, int namelen, bool isWsa) {
    auto& config = Core::Config::Instance();
    
    // 超时控制
    Network::SocketWrapper sock(s);
    sock.SetTimeouts(config.timeout.recv_ms, config.timeout.send_ms);
    
    if (name->sa_family != AF_INET) {
        // 非 IPv4，直接调用原始函数
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }
    
    sockaddr_in* addr = (sockaddr_in*)name;
    uint16_t originalPort = ntohs(addr->sin_port);
    std::string originalHost;
    
    // 检查是否为 FakeIP，如果是则还原域名
    if (Network::FakeIP::Instance().IsFakeIP(addr->sin_addr.s_addr)) {
        originalHost = Network::FakeIP::Instance().GetDomain(addr->sin_addr.s_addr);
        if (originalHost.empty()) {
            originalHost = Network::FakeIP::IpToString(addr->sin_addr.s_addr);
        }
    } else {
        originalHost = Network::FakeIP::IpToString(addr->sin_addr.s_addr);
    }
    
    // 保存原始目标
    g_currentTarget.host = originalHost;
    g_currentTarget.port = originalPort;
    
    // 如果配置了代理
    if (config.proxy.port != 0) {
        Core::Logger::Info("Redirecting " + originalHost + ":" + std::to_string(originalPort) + " to proxy");
        
        // 修改目标地址为代理服务器
        sockaddr_in proxyAddr = *addr;
        inet_pton(AF_INET, config.proxy.host.c_str(), &proxyAddr.sin_addr);
        proxyAddr.sin_port = htons(config.proxy.port);
        
        // 连接到代理
        int result = isWsa ? 
            fpWSAConnect(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr), NULL, NULL, NULL, NULL) :
            fpConnect(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr));
        
        if (result != 0) {
            Core::Logger::Error("Failed to connect to proxy");
            return result;
        }
        
        // 执行 SOCKS5 握手
        if (config.proxy.type == "socks5") {
            if (!Network::Socks5Client::Handshake(s, originalHost, originalPort)) {
                Core::Logger::Error("SOCKS5 handshake failed");
                WSASetLastError(WSAECONNREFUSED);
                return SOCKET_ERROR;
            }
        }
        
        return 0; // 成功
    }
    
    // 无代理配置，直接连接
    return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
}

// ============= Hook 函数实现 =============

int WSAAPI DetourConnect(SOCKET s, const struct sockaddr* name, int namelen) {
    return PerformProxyConnect(s, name, namelen, false);
}

int WSAAPI DetourWSAConnect(SOCKET s, const struct sockaddr* name, int namelen, 
                            LPWSABUF lpCallerData, LPWSABUF lpCalleeData, 
                            LPQOS lpSQOS, LPQOS lpGQOS) {
    // 忽略额外参数，使用统一的代理逻辑
    return PerformProxyConnect(s, name, namelen, true);
}

int WSAAPI DetourGetAddrInfo(PCSTR pNodeName, PCSTR pServiceName, 
                              const ADDRINFOA* pHints, PADDRINFOA* ppResult) {
    auto& config = Core::Config::Instance();
    
    // 如果启用了 FakeIP 且有域名请求
    if (pNodeName && config.fakeIp.enabled) {
        Core::Logger::Info("getaddrinfo intercepted: " + std::string(pNodeName));
        
        // 分配虚拟 IP
        uint32_t fakeIp = Network::FakeIP::Instance().Alloc(pNodeName);
        
        // 手动构造 ADDRINFOA 结构
        ADDRINFOA* result = (ADDRINFOA*)malloc(sizeof(ADDRINFOA));
        sockaddr_in* addr = (sockaddr_in*)malloc(sizeof(sockaddr_in));
        
        if (result && addr) {
            memset(result, 0, sizeof(ADDRINFOA));
            memset(addr, 0, sizeof(sockaddr_in));
            
            addr->sin_family = AF_INET;
            addr->sin_addr.s_addr = fakeIp;
            addr->sin_port = 0;
            
            result->ai_family = AF_INET;
            result->ai_socktype = SOCK_STREAM;
            result->ai_protocol = IPPROTO_TCP;
            result->ai_addrlen = sizeof(sockaddr_in);
            result->ai_addr = (sockaddr*)addr;
            result->ai_next = NULL;
            
            *ppResult = result;
            return 0; // 成功
        }
    }
    
    // 调用原始函数
    return fpGetAddrInfo(pNodeName, pServiceName, pHints, ppResult);
}

// ============= Hook 管理 =============

namespace Hooks {
    void Install() {
        if (MH_Initialize() != MH_OK) {
            Core::Logger::Error("MinHook Init Failed");
            return;
        }
        
        // Hook connect
        if (MH_CreateHookApi(L"ws2_32.dll", "connect", 
                             (LPVOID)DetourConnect, (LPVOID*)&fpConnect) != MH_OK) {
            Core::Logger::Error("Hook connect failed");
        }
        
        // Hook WSAConnect
        if (MH_CreateHookApi(L"ws2_32.dll", "WSAConnect", 
                             (LPVOID)DetourWSAConnect, (LPVOID*)&fpWSAConnect) != MH_OK) {
            Core::Logger::Error("Hook WSAConnect failed");
        }
        
        // Hook getaddrinfo
        if (MH_CreateHookApi(L"ws2_32.dll", "getaddrinfo", 
                             (LPVOID)DetourGetAddrInfo, (LPVOID*)&fpGetAddrInfo) != MH_OK) {
            Core::Logger::Error("Hook getaddrinfo failed");
        }
        
        if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
            Core::Logger::Error("Enable Hooks failed");
        } else {
            Core::Logger::Info("All Hooks Installed Successfully");
        }
    }
    
    void Uninstall() {
        MH_DisableHook(MH_ALL_HOOKS);
        MH_Uninitialize();
    }
}
