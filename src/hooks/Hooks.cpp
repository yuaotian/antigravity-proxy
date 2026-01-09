// 防止 windows.h 自动包含 winsock.h (避免与 winsock2.h 冲突)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <MinHook.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mswsock.h>
#include <unordered_map>
#include <mutex>
#include "../core/Config.hpp"
#include "../core/Logger.hpp"
#include "../network/SocketWrapper.hpp"
#include "../network/FakeIP.hpp"
#include "../network/Socks5.hpp"
#include "../network/HttpConnect.hpp"
#include "../network/SocketIo.hpp"
#include "../network/TrafficMonitor.hpp"
#include "../injection/ProcessInjector.hpp"

// ============= 函数指针类型定义 =============
typedef int (WSAAPI *connect_t)(SOCKET, const struct sockaddr*, int);
typedef int (WSAAPI *WSAConnect_t)(SOCKET, const struct sockaddr*, int, LPWSABUF, LPWSABUF, LPQOS, LPQOS);
typedef int (WSAAPI *getaddrinfo_t)(PCSTR, PCSTR, const ADDRINFOA*, PADDRINFOA*);
typedef int (WSAAPI *getaddrinfoW_t)(PCWSTR, PCWSTR, const ADDRINFOW*, PADDRINFOW*);
typedef int (WSAAPI *send_t)(SOCKET, const char*, int, int);
typedef int (WSAAPI *recv_t)(SOCKET, char*, int, int);
typedef int (WSAAPI *WSASend_t)(SOCKET, LPWSABUF, DWORD, LPDWORD, DWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef int (WSAAPI *WSARecv_t)(SOCKET, LPWSABUF, DWORD, LPDWORD, LPDWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef BOOL (WSAAPI *WSAConnectByNameA_t)(SOCKET, LPCSTR, LPCSTR, LPDWORD, LPSOCKADDR, LPDWORD, LPSOCKADDR, const struct timeval*, LPWSAOVERLAPPED);
typedef BOOL (WSAAPI *WSAConnectByNameW_t)(SOCKET, LPWSTR, LPWSTR, LPDWORD, LPSOCKADDR, LPDWORD, LPSOCKADDR, const struct timeval*, LPWSAOVERLAPPED);
typedef int (WSAAPI *WSAIoctl_t)(SOCKET, DWORD, LPVOID, DWORD, LPVOID, DWORD, LPDWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef BOOL (WSAAPI *WSAGetOverlappedResult_t)(SOCKET, LPWSAOVERLAPPED, LPDWORD, BOOL, LPDWORD);
typedef BOOL (WINAPI *GetQueuedCompletionStatus_t)(HANDLE, LPDWORD, PULONG_PTR, LPOVERLAPPED*, DWORD);
typedef BOOL (WINAPI *CreateProcessW_t)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
// GetQueuedCompletionStatusEx 函数指针类型 - 用于批量获取 IOCP 事件（现代高性能应用必需）
typedef BOOL (WINAPI *GetQueuedCompletionStatusEx_t)(
    HANDLE CompletionPort,
    LPOVERLAPPED_ENTRY lpCompletionPortEntries,
    ULONG ulCount,
    PULONG ulNumEntriesRemoved,
    DWORD dwMilliseconds,
    BOOL fAlertable
);

// ============= 原始函数指针 =============
connect_t fpConnect = NULL;
WSAConnect_t fpWSAConnect = NULL;
getaddrinfo_t fpGetAddrInfo = NULL;
getaddrinfoW_t fpGetAddrInfoW = NULL;
send_t fpSend = NULL;
recv_t fpRecv = NULL;
WSASend_t fpWSASend = NULL;
WSARecv_t fpWSARecv = NULL;
WSAConnectByNameA_t fpWSAConnectByNameA = NULL;
WSAConnectByNameW_t fpWSAConnectByNameW = NULL;
WSAIoctl_t fpWSAIoctl = NULL;
WSAGetOverlappedResult_t fpWSAGetOverlappedResult = NULL;
GetQueuedCompletionStatus_t fpGetQueuedCompletionStatus = NULL;
LPFN_CONNECTEX fpConnectEx = NULL;
CreateProcessW_t fpCreateProcessW = NULL;
GetQueuedCompletionStatusEx_t fpGetQueuedCompletionStatusEx = NULL; // 批量 IOCP 事件获取

// ============= 辅助函数 =============

// 保存原始目标地址用于 SOCKS5 握手
struct OriginalTarget {
    std::string host;
    uint16_t port;
};

// 线程本地存储，保存当前连接的原始目标
thread_local OriginalTarget g_currentTarget;

// ConnectEx 异步上下文
struct ConnectExContext {
    SOCKET sock;
    std::string host;
    uint16_t port;
    const char* sendBuf;
    DWORD sendLen;
    LPDWORD bytesSent;
    ULONGLONG createdTick; // 记录创建时间，便于清理超时上下文
};

static std::unordered_map<LPOVERLAPPED, ConnectExContext> g_connectExPending;
static std::mutex g_connectExMtx;
static std::mutex g_connectExHookMtx;
static bool g_connectExHookInstalled = false;
static const ULONGLONG kConnectExPendingTtlMs = 60000; // 超过 60 秒的上下文视为过期

// 为了避免日志被大量非目标进程淹没，这里仅首次记录“跳过注入”的进程名
static std::unordered_map<std::string, bool> g_loggedSkipProcesses;
static std::mutex g_loggedSkipProcessesMtx;
static const size_t kMaxLoggedSkipProcesses = 256; // 限制缓存规模，避免无限增长

static std::string WideToUtf8(PCWSTR input) {
    if (!input) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, input, -1, NULL, 0, NULL, NULL);
    if (len <= 0) return "";
    std::string result(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, input, -1, &result[0], len, NULL, NULL);
    if (!result.empty() && result.back() == '\0') result.pop_back();
    return result;
}

static bool ResolveOriginalTarget(const sockaddr* name, std::string* host, uint16_t* port) {
    if (!name || name->sa_family != AF_INET) return false;
    auto* addr = (sockaddr_in*)name;
    if (port) *port = ntohs(addr->sin_port);
    if (host) {
        if (Network::FakeIP::Instance().IsFakeIP(addr->sin_addr.s_addr)) {
            *host = Network::FakeIP::Instance().GetDomain(addr->sin_addr.s_addr);
            if (host->empty()) {
                *host = Network::FakeIP::IpToString(addr->sin_addr.s_addr);
            }
        } else {
            *host = Network::FakeIP::IpToString(addr->sin_addr.s_addr);
        }
    }
    return true;
}

static bool IsLoopbackHost(const std::string& host) {
    if (host == "127.0.0.1" || host == "localhost" || host == "::1") return true;
    return host.size() >= 4 && host.substr(0, 4) == "127.";
}

// 判断是否为 IP 字面量（IPv4/IPv6），避免对纯 IP 走 FakeIP 影响原始语义
static bool IsIpLiteralHost(const std::string& host) {
    in_addr addr4{};
    if (inet_pton(AF_INET, host.c_str(), &addr4) == 1) return true;
    in6_addr addr6{};
    if (inet_pton(AF_INET6, host.c_str(), &addr6) == 1) return true;
    return false;
}

// 将 sockaddr 转成可读地址，便于日志排查
static std::string SockaddrToString(const sockaddr* addr) {
    if (!addr) return "";
    if (addr->sa_family == AF_INET) {
        const auto* addr4 = (const sockaddr_in*)addr;
        char buf[INET_ADDRSTRLEN] = {};
        if (!inet_ntop(AF_INET, &addr4->sin_addr, buf, sizeof(buf))) return "";
        return std::string(buf) + ":" + std::to_string(ntohs(addr4->sin_port));
    }
    if (addr->sa_family == AF_INET6) {
        const auto* addr6 = (const sockaddr_in6*)addr;
        char buf[INET6_ADDRSTRLEN] = {};
        if (!inet_ntop(AF_INET6, &addr6->sin6_addr, buf, sizeof(buf))) return "";
        return std::string(buf) + ":" + std::to_string(ntohs(addr6->sin6_port));
    }
    return "";
}

static std::wstring Utf8ToWide(const std::string& input) {
    if (input.empty()) return L"";
    int len = MultiByteToWideChar(CP_UTF8, 0, input.c_str(), -1, NULL, 0);
    if (len <= 0) return L"";
    std::wstring result(len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, input.c_str(), -1, &result[0], len);
    if (!result.empty() && result.back() == L'\0') result.pop_back();
    return result;
}

static bool IsProxySelfTarget(const std::string& host, uint16_t port, const Core::ProxyConfig& proxy) {
    return port == proxy.port && (host == proxy.host || host == "127.0.0.1");
}

static bool BuildProxyAddr(const Core::ProxyConfig& proxy, sockaddr_in* proxyAddr, const sockaddr_in* baseAddr) {
    if (!proxyAddr) return false;
    if (baseAddr) {
        *proxyAddr = *baseAddr;
    } else {
        memset(proxyAddr, 0, sizeof(sockaddr_in));
        proxyAddr->sin_family = AF_INET;
    }
    if (inet_pton(AF_INET, proxy.host.c_str(), &proxyAddr->sin_addr) != 1) {
        // 尝试使用 DNS 解析代理主机名（仅 IPv4）
        addrinfo hints{};
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        addrinfo* res = nullptr;
        int rc = fpGetAddrInfo ? fpGetAddrInfo(proxy.host.c_str(), nullptr, &hints, &res)
                               : getaddrinfo(proxy.host.c_str(), nullptr, &hints, &res);
        if (rc != 0 || !res) {
            Core::Logger::Error("代理地址解析失败: " + proxy.host + ", 错误码=" + std::to_string(rc));
            return false;
        }
        auto* addr = (sockaddr_in*)res->ai_addr;
        proxyAddr->sin_addr = addr->sin_addr;
        freeaddrinfo(res);
    }
    proxyAddr->sin_port = htons(proxy.port);
    return true;
}

// 解析目标域名为 IPv4 地址，供 WSAConnectByName 走代理
static bool ResolveNameToAddr(const std::string& node, const std::string& service, sockaddr_in* out) {
    if (!out || node.empty()) return false;
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    addrinfo* res = nullptr;
    const char* serviceStr = service.empty() ? nullptr : service.c_str();
    int rc = fpGetAddrInfo ? fpGetAddrInfo(node.c_str(), serviceStr, &hints, &res)
                           : getaddrinfo(node.c_str(), serviceStr, &hints, &res);
    if (rc != 0 || !res) {
        Core::Logger::Error("目标地址解析失败: " + node + ", 错误码=" + std::to_string(rc));
        return false;
    }
    *out = *(sockaddr_in*)res->ai_addr;
    freeaddrinfo(res);
    return true;
}

static bool DoProxyHandshake(SOCKET s, const std::string& host, uint16_t port) {
    auto& config = Core::Config::Instance();
    if (config.proxy.type == "socks5") {
        if (!Network::Socks5Client::Handshake(s, host, port)) {
            Core::Logger::Error("SOCKS5 握手失败");
            WSASetLastError(WSAECONNREFUSED);
            return false;
        }
    } else if (config.proxy.type == "http") {
        if (!Network::HttpConnectClient::Handshake(s, host, port)) {
            Core::Logger::Error("HTTP CONNECT 握手失败");
            WSASetLastError(WSAECONNREFUSED);
            return false;
        }
    } else {
        Core::Logger::Error("未知代理类型: " + config.proxy.type);
        WSASetLastError(WSAECONNREFUSED);
        return false;
    }
    return true;
}

static void PurgeStaleConnectExContexts(ULONGLONG now) {
    // 清理长时间未完成的 ConnectEx 上下文，避免内存堆积
    for (auto it = g_connectExPending.begin(); it != g_connectExPending.end(); ) {
        if (now - it->second.createdTick > kConnectExPendingTtlMs) {
            it = g_connectExPending.erase(it);
        } else {
            ++it;
        }
    }
}

static void SaveConnectExContext(LPOVERLAPPED ovl, const ConnectExContext& ctx) {
    std::lock_guard<std::mutex> lock(g_connectExMtx);
    ULONGLONG now = GetTickCount64();
    PurgeStaleConnectExContexts(now);
    ConnectExContext copy = ctx;
    copy.createdTick = now;
    g_connectExPending[ovl] = copy;
}

static bool PopConnectExContext(LPOVERLAPPED ovl, ConnectExContext* out) {
    std::lock_guard<std::mutex> lock(g_connectExMtx);
    auto it = g_connectExPending.find(ovl);
    if (it == g_connectExPending.end()) return false;
    if (out) *out = it->second;
    g_connectExPending.erase(it);
    return true;
}

static void DropConnectExContext(LPOVERLAPPED ovl) {
    std::lock_guard<std::mutex> lock(g_connectExMtx);
    g_connectExPending.erase(ovl);
}

static bool HandleConnectExCompletion(LPOVERLAPPED ovl) {
    ConnectExContext ctx{};
    if (!PopConnectExContext(ovl, &ctx)) return true;
    if (!DoProxyHandshake(ctx.sock, ctx.host, ctx.port)) {
        return false;
    }
    if (ctx.sendBuf && ctx.sendLen > 0) {
        int sent = fpSend ? fpSend(ctx.sock, ctx.sendBuf, (int)ctx.sendLen, 0) : send(ctx.sock, ctx.sendBuf, (int)ctx.sendLen, 0);
        if (sent == SOCKET_ERROR) {
            int err = WSAGetLastError();
            Core::Logger::Error("ConnectEx 发送首包失败, WSA错误码=" + std::to_string(err));
            WSASetLastError(err);
            return false;
        }
        if (ctx.bytesSent) {
            *ctx.bytesSent = (DWORD)sent;
        }
    }
    return true;
}

BOOL PASCAL DetourConnectEx(
    SOCKET s,
    const struct sockaddr* name,
    int namelen,
    PVOID lpSendBuffer,
    DWORD dwSendDataLength,
    LPDWORD lpdwBytesSent,
    LPOVERLAPPED lpOverlapped
);

// 执行代理连接逻辑
int PerformProxyConnect(SOCKET s, const struct sockaddr* name, int namelen, bool isWsa) {
    auto& config = Core::Config::Instance();
    
    // 超时控制
    Network::SocketWrapper sock(s);
    sock.SetTimeouts(config.timeout.recv_ms, config.timeout.send_ms);
    
    // 基础参数校验，避免空指针/长度不足导致崩溃
    if (!name) {
        WSASetLastError(WSAEFAULT);
        return SOCKET_ERROR;
    }
    if (namelen < (int)sizeof(sockaddr)) {
        WSASetLastError(WSAEINVAL);
        return SOCKET_ERROR;
    }
    if (name->sa_family == AF_INET && namelen < (int)sizeof(sockaddr_in)) {
        WSASetLastError(WSAEINVAL);
        return SOCKET_ERROR;
    }
    
    if (name->sa_family != AF_INET) {
        std::string addrStr = SockaddrToString(name);
        if (config.proxy.port != 0) {
            // 强制 IPv4：阻止 IPv6 直连，避免绕过代理
            Core::Logger::Warn("已阻止非 IPv4 连接(强制 IPv4), family=" + std::to_string((int)name->sa_family) +
                               (addrStr.empty() ? "" : ", addr=" + addrStr));
            WSASetLastError(WSAEAFNOSUPPORT);
            return SOCKET_ERROR;
        }
        Core::Logger::Info("非 IPv4 连接已直连, family=" + std::to_string((int)name->sa_family) +
                           (addrStr.empty() ? "" : ", addr=" + addrStr));
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }
    
    std::string originalHost;
    uint16_t originalPort = 0;
    if (!ResolveOriginalTarget(name, &originalHost, &originalPort)) {
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }
    
    // 保存原始目标
    g_currentTarget.host = originalHost;
    g_currentTarget.port = originalPort;
    
    // BYPASS: 跳过本地回环地址，避免代理死循环
    if (IsLoopbackHost(originalHost)) {
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }
    
    // BYPASS: 如果目标端口就是代理端口，直连（防止代理自连接）
    if (IsProxySelfTarget(originalHost, originalPort, config.proxy)) {
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }
    
    // 如果配置了代理
    if (config.proxy.port != 0) {
        Core::Logger::Info("正重定向 " + originalHost + ":" + std::to_string(originalPort) + " 到代理");
        
        // 修改目标地址为代理服务器
        sockaddr_in proxyAddr{};
        if (!BuildProxyAddr(config.proxy, &proxyAddr, (sockaddr_in*)name)) {
            WSASetLastError(WSAEINVAL);
            return SOCKET_ERROR;
        }
        
        // 连接到代理
        int result = isWsa ? 
            fpWSAConnect(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr), NULL, NULL, NULL, NULL) :
            fpConnect(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr));
        
        if (result != 0) {
            int err = WSAGetLastError();
            if (err == WSAEWOULDBLOCK || err == WSAEINPROGRESS) {
                // 非阻塞 connect 需要等待连接完成
                if (!Network::SocketIo::WaitConnect(s, config.timeout.connect_ms)) {
                    int waitErr = WSAGetLastError();
                    Core::Logger::Error("连接代理服务器失败, WSA错误码=" + std::to_string(waitErr));
                    return SOCKET_ERROR;
                }
            } else {
                Core::Logger::Error("连接代理服务器失败, WSA错误码=" + std::to_string(err));
                return result;
            }
        }
        
        if (!DoProxyHandshake(s, originalHost, originalPort)) {
            return SOCKET_ERROR;
        }
        
        return 0; // 成功
    }
    
    // 无代理配置，直接连接
    return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
}

// ============= Phase 1: 网络 Hook 函数实现 =============

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
    
    if (!fpGetAddrInfo) return EAI_FAIL;

    // 如果启用了 FakeIP 且有域名请求
    if (pNodeName && config.fakeIp.enabled) {
        std::string node = pNodeName;
        // 重要：回环/纯 IP 不走 FakeIP，避免与回环 bypass 逻辑冲突，也避免改变原始解析语义
        if (!node.empty() && !IsLoopbackHost(node) && !IsIpLiteralHost(node)) {
            Core::Logger::Info("拦截到域名解析: " + node);
            // 分配虚拟 IP，并让原始 getaddrinfo 生成结果结构（保证 freeaddrinfo 释放契约一致）
            uint32_t fakeIp = Network::FakeIP::Instance().Alloc(node);
            if (fakeIp != 0) {
                std::string fakeIpStr = Network::FakeIP::IpToString(fakeIp);
                return fpGetAddrInfo(fakeIpStr.c_str(), pServiceName, pHints, ppResult);
            }
            // FakeIP 达到上限时回退原始解析
        }
    }

    // 调用原始函数
    return fpGetAddrInfo(pNodeName, pServiceName, pHints, ppResult);
}

int WSAAPI DetourGetAddrInfoW(PCWSTR pNodeName, PCWSTR pServiceName, 
                              const ADDRINFOW* pHints, PADDRINFOW* ppResult) {
    auto& config = Core::Config::Instance();
    
    if (!fpGetAddrInfoW) return EAI_FAIL;

    // 如果启用了 FakeIP 且有域名请求
    if (pNodeName && config.fakeIp.enabled) {
        std::string nodeUtf8 = WideToUtf8(pNodeName);
        // 重要：回环/纯 IP 不走 FakeIP，避免与回环 bypass 逻辑冲突，也避免改变原始解析语义
        if (!nodeUtf8.empty() && !IsLoopbackHost(nodeUtf8) && !IsIpLiteralHost(nodeUtf8)) {
            Core::Logger::Info("拦截到域名解析(W): " + nodeUtf8);
            // 分配虚拟 IP，并让原始 GetAddrInfoW 生成结果结构（保证 FreeAddrInfoW/freeaddrinfo 契约一致）
            uint32_t fakeIp = Network::FakeIP::Instance().Alloc(nodeUtf8);
            if (fakeIp != 0) {
                std::string fakeIpStr = Network::FakeIP::IpToString(fakeIp);
                std::wstring fakeIpW = Utf8ToWide(fakeIpStr);
                return fpGetAddrInfoW(fakeIpW.c_str(), pServiceName, pHints, ppResult);
            }
            // FakeIP 达到上限时回退原始解析
        }
    }

    return fpGetAddrInfoW(pNodeName, pServiceName, pHints, ppResult);
}

BOOL WSAAPI DetourWSAConnectByNameA(
    SOCKET s,
    LPCSTR nodename,
    LPCSTR servicename,
    LPDWORD LocalAddressLength,
    LPSOCKADDR LocalAddress,
    LPDWORD RemoteAddressLength,
    LPSOCKADDR RemoteAddress,
    const struct timeval* timeout,
    LPWSAOVERLAPPED Reserved
) {
    std::string node = nodename ? nodename : "";
    std::string service = servicename ? servicename : "";
    std::string msg = "拦截到 WSAConnectByNameA: " + node;
    if (!service.empty()) msg += ":" + service;
    Core::Logger::Info(msg);
    if (!fpWSAConnectByNameA) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    auto& config = Core::Config::Instance();
    if (config.proxy.port != 0 && !node.empty() && !Reserved) {
        sockaddr_in targetAddr{};
        if (ResolveNameToAddr(node, service, &targetAddr)) {
            // 回填目标地址（如调用方提供缓冲区）
            if (RemoteAddress && RemoteAddressLength && *RemoteAddressLength >= sizeof(sockaddr_in)) {
                memcpy(RemoteAddress, &targetAddr, sizeof(sockaddr_in));
                *RemoteAddressLength = sizeof(sockaddr_in);
            }
            int rc = PerformProxyConnect(s, (sockaddr*)&targetAddr, sizeof(targetAddr), true);
            return rc == 0 ? TRUE : FALSE;
        }
        Core::Logger::Warn("WSAConnectByNameA 解析失败，回退原始实现");
    } else if (Reserved) {
        Core::Logger::Info("WSAConnectByNameA 使用 Overlapped，回退原始实现");
    }
    return fpWSAConnectByNameA(s, nodename, servicename, LocalAddressLength, LocalAddress, RemoteAddressLength, RemoteAddress, timeout, Reserved);
}

BOOL WSAAPI DetourWSAConnectByNameW(
    SOCKET s,
    LPWSTR nodename,
    LPWSTR servicename,
    LPDWORD LocalAddressLength,
    LPSOCKADDR LocalAddress,
    LPDWORD RemoteAddressLength,
    LPSOCKADDR RemoteAddress,
    const struct timeval* timeout,
    LPWSAOVERLAPPED Reserved
) {
    std::string node = WideToUtf8(nodename);
    std::string service = WideToUtf8(servicename);
    std::string msg = "拦截到 WSAConnectByNameW: " + node;
    if (!service.empty()) msg += ":" + service;
    Core::Logger::Info(msg);
    if (!fpWSAConnectByNameW) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    auto& config = Core::Config::Instance();
    if (config.proxy.port != 0 && !node.empty() && !Reserved) {
        sockaddr_in targetAddr{};
        if (ResolveNameToAddr(node, service, &targetAddr)) {
            // 回填目标地址（如调用方提供缓冲区）
            if (RemoteAddress && RemoteAddressLength && *RemoteAddressLength >= sizeof(sockaddr_in)) {
                memcpy(RemoteAddress, &targetAddr, sizeof(sockaddr_in));
                *RemoteAddressLength = sizeof(sockaddr_in);
            }
            int rc = PerformProxyConnect(s, (sockaddr*)&targetAddr, sizeof(targetAddr), true);
            return rc == 0 ? TRUE : FALSE;
        }
        Core::Logger::Warn("WSAConnectByNameW 解析失败，回退原始实现");
    } else if (Reserved) {
        Core::Logger::Info("WSAConnectByNameW 使用 Overlapped，回退原始实现");
    }
    return fpWSAConnectByNameW(s, nodename, servicename, LocalAddressLength, LocalAddress, RemoteAddressLength, RemoteAddress, timeout, Reserved);
}

int WSAAPI DetourWSAIoctl(
    SOCKET s,
    DWORD dwIoControlCode,
    LPVOID lpvInBuffer,
    DWORD cbInBuffer,
    LPVOID lpvOutBuffer,
    DWORD cbOutBuffer,
    LPDWORD lpcbBytesReturned,
    LPWSAOVERLAPPED lpOverlapped,
    LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine
) {
    if (!fpWSAIoctl) return SOCKET_ERROR;
    int result = fpWSAIoctl(s, dwIoControlCode, lpvInBuffer, cbInBuffer, lpvOutBuffer, cbOutBuffer,
                            lpcbBytesReturned, lpOverlapped, lpCompletionRoutine);
    if (result == 0 && dwIoControlCode == SIO_GET_EXTENSION_FUNCTION_POINTER &&
        lpvInBuffer && cbInBuffer == sizeof(GUID) &&
        lpvOutBuffer && cbOutBuffer >= sizeof(LPFN_CONNECTEX)) {
        GUID guid = *(GUID*)lpvInBuffer;
        if (IsEqualGUID(guid, WSAID_CONNECTEX)) {
            LPFN_CONNECTEX connectEx = *(LPFN_CONNECTEX*)lpvOutBuffer;
            if (connectEx && !g_connectExHookInstalled) {
                std::lock_guard<std::mutex> lock(g_connectExHookMtx);
                if (!g_connectExHookInstalled) {
                    if (MH_CreateHook((LPVOID)connectEx, (LPVOID)DetourConnectEx, (LPVOID*)&fpConnectEx) != MH_OK) {
                        Core::Logger::Error("Hook ConnectEx 失败");
                    } else if (MH_EnableHook((LPVOID)connectEx) != MH_OK) {
                        Core::Logger::Error("启用 ConnectEx Hook 失败");
                    } else {
                        g_connectExHookInstalled = true;
                        Core::Logger::Info("ConnectEx Hook 已安装");
                    }
                }
            }
        }
    }
    return result;
}

BOOL PASCAL DetourConnectEx(
    SOCKET s,
    const struct sockaddr* name,
    int namelen,
    PVOID lpSendBuffer,
    DWORD dwSendDataLength,
    LPDWORD lpdwBytesSent,
    LPOVERLAPPED lpOverlapped
) {
    if (!fpConnectEx) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    // 基础参数校验，避免空指针/长度不足导致崩溃
    if (!name) {
        WSASetLastError(WSAEFAULT);
        return FALSE;
    }
    if (namelen < (int)sizeof(sockaddr)) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    if (name->sa_family == AF_INET && namelen < (int)sizeof(sockaddr_in)) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    
    auto& config = Core::Config::Instance();
    Network::SocketWrapper sock(s);
    sock.SetTimeouts(config.timeout.recv_ms, config.timeout.send_ms);
    
    if (name->sa_family != AF_INET) {
        std::string addrStr = SockaddrToString(name);
        if (config.proxy.port != 0) {
            // 强制 IPv4：阻止 IPv6 直连，避免绕过代理
            Core::Logger::Warn("ConnectEx 已阻止非 IPv4 连接(强制 IPv4), family=" + std::to_string((int)name->sa_family) +
                               (addrStr.empty() ? "" : ", addr=" + addrStr));
            WSASetLastError(WSAEAFNOSUPPORT);
            return FALSE;
        }
        Core::Logger::Info("ConnectEx 非 IPv4 连接已直连, family=" + std::to_string((int)name->sa_family) +
                           (addrStr.empty() ? "" : ", addr=" + addrStr));
        return fpConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    std::string originalHost;
    uint16_t originalPort = 0;
    if (!ResolveOriginalTarget(name, &originalHost, &originalPort)) {
        return fpConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    if (IsLoopbackHost(originalHost) || IsProxySelfTarget(originalHost, originalPort, config.proxy)) {
        return fpConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    if (config.proxy.port == 0) {
        return fpConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    Core::Logger::Info("ConnectEx 正重定向 " + originalHost + ":" + std::to_string(originalPort) + " 到代理");
    
    sockaddr_in proxyAddr{};
    if (!BuildProxyAddr(config.proxy, &proxyAddr, (sockaddr_in*)name)) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    
    DWORD ignoredBytes = 0;
    BOOL result = fpConnectEx(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr), NULL, 0,
                              lpdwBytesSent ? lpdwBytesSent : &ignoredBytes, lpOverlapped);
    if (!result) {
        int err = WSAGetLastError();
        if (err == WSA_IO_PENDING) {
            if (lpOverlapped) {
                ConnectExContext ctx{};
                ctx.sock = s;
                ctx.host = originalHost;
                ctx.port = originalPort;
                ctx.sendBuf = (const char*)lpSendBuffer;
                ctx.sendLen = dwSendDataLength;
                ctx.bytesSent = lpdwBytesSent;
                SaveConnectExContext(lpOverlapped, ctx);
            } else {
                Core::Logger::Info("ConnectEx 返回 WSA_IO_PENDING 但未提供 Overlapped");
            }
            return FALSE;
        }
        Core::Logger::Error("ConnectEx 连接代理服务器失败, WSA错误码=" + std::to_string(err));
        WSASetLastError(err);
        return FALSE;
    }
    
    if (!DoProxyHandshake(s, originalHost, originalPort)) {
        return FALSE;
    }
    
    if (lpSendBuffer && dwSendDataLength > 0) {
        int sent = fpSend ? fpSend(s, (const char*)lpSendBuffer, (int)dwSendDataLength, 0) : send(s, (const char*)lpSendBuffer, (int)dwSendDataLength, 0);
        if (sent == SOCKET_ERROR) {
            int err = WSAGetLastError();
            Core::Logger::Error("ConnectEx 发送首包失败, WSA错误码=" + std::to_string(err));
            WSASetLastError(err);
            return FALSE;
        }
        if (lpdwBytesSent) {
            *lpdwBytesSent = (DWORD)sent;
        }
    }
    
    return TRUE;
}

BOOL WSAAPI DetourWSAGetOverlappedResult(
    SOCKET s,
    LPWSAOVERLAPPED lpOverlapped,
    LPDWORD lpcbTransfer,
    BOOL fWait,
    LPDWORD lpdwFlags
) {
    if (!fpWSAGetOverlappedResult) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    BOOL result = fpWSAGetOverlappedResult(s, lpOverlapped, lpcbTransfer, fWait, lpdwFlags);
    if (result && lpOverlapped) {
        if (!HandleConnectExCompletion(lpOverlapped)) {
            if (WSAGetLastError() == 0) WSASetLastError(WSAECONNREFUSED);
            return FALSE;
        }
    } else if (!result && lpOverlapped) {
        int err = WSAGetLastError();
        if (err != WSA_IO_INCOMPLETE) {
            DropConnectExContext(lpOverlapped);
        }
    }
    return result;
}

BOOL WINAPI DetourGetQueuedCompletionStatus(
    HANDLE CompletionPort,
    LPDWORD lpNumberOfBytes,
    PULONG_PTR lpCompletionKey,
    LPOVERLAPPED* lpOverlapped,
    DWORD dwMilliseconds
) {
    if (!fpGetQueuedCompletionStatus) {
        SetLastError(ERROR_INVALID_FUNCTION);
        return FALSE;
    }
    BOOL result = fpGetQueuedCompletionStatus(CompletionPort, lpNumberOfBytes, lpCompletionKey, lpOverlapped, dwMilliseconds);
    if (result && lpOverlapped && *lpOverlapped) {
        if (!HandleConnectExCompletion(*lpOverlapped)) {
            if (GetLastError() == 0) SetLastError(WSAECONNREFUSED);
            return FALSE;
        }
    } else if (!result && lpOverlapped && *lpOverlapped) {
        DropConnectExContext(*lpOverlapped);
    }
    return result;
}

// GetQueuedCompletionStatusEx Hook - 批量获取 IOCP 事件
// 现代高性能应用（Chromium/Rust/Go）使用此 API 提高吞吐量，
// 如果不 Hook 此函数，ConnectEx 完成后的代理握手将被跳过
BOOL WINAPI DetourGetQueuedCompletionStatusEx(
    HANDLE CompletionPort,
    LPOVERLAPPED_ENTRY lpCompletionPortEntries,
    ULONG ulCount,
    PULONG ulNumEntriesRemoved,
    DWORD dwMilliseconds,
    BOOL fAlertable
) {
    if (!fpGetQueuedCompletionStatusEx) {
        SetLastError(ERROR_INVALID_FUNCTION);
        return FALSE;
    }
    
    // 调用原始函数获取批量 IOCP 事件
    BOOL result = fpGetQueuedCompletionStatusEx(
        CompletionPort, lpCompletionPortEntries, ulCount,
        ulNumEntriesRemoved, dwMilliseconds, fAlertable
    );
    
    if (result && lpCompletionPortEntries && ulNumEntriesRemoved && *ulNumEntriesRemoved > 0) {
        // 遍历所有完成的事件，检查是否有待处理的 ConnectEx 上下文
        for (ULONG i = 0; i < *ulNumEntriesRemoved; i++) {
            LPOVERLAPPED ovl = lpCompletionPortEntries[i].lpOverlapped;
            if (ovl) {
                // 尝试处理 ConnectEx 完成握手
                // 如果不是我们跟踪的 Overlapped，HandleConnectExCompletion 会直接返回 true
                if (!HandleConnectExCompletion(ovl)) {
                    // 握手失败，记录日志供调试
                    Core::Logger::Error("GetQueuedCompletionStatusEx: ConnectEx 握手失败");
                    // 握手失败时直接返回 FALSE，避免调用方误判为成功
                    if (GetLastError() == 0) SetLastError(WSAECONNREFUSED);
                    return FALSE;
                }
            }
        }
    } else if (!result && lpCompletionPortEntries && ulNumEntriesRemoved && *ulNumEntriesRemoved > 0) {
        // 失败时清理残留上下文，避免 Overlapped 复用导致错配
        for (ULONG i = 0; i < *ulNumEntriesRemoved; i++) {
            LPOVERLAPPED ovl = lpCompletionPortEntries[i].lpOverlapped;
            if (ovl) {
                DropConnectExContext(ovl);
            }
        }
    }
    
    return result;
}

// ============= Phase 2: CreateProcessW Hook =============

BOOL WINAPI DetourCreateProcessW(
    LPCWSTR lpApplicationName,
    LPWSTR lpCommandLine,
    LPSECURITY_ATTRIBUTES lpProcessAttributes,
    LPSECURITY_ATTRIBUTES lpThreadAttributes,
    BOOL bInheritHandles,
    DWORD dwCreationFlags,
    LPVOID lpEnvironment,
    LPCWSTR lpCurrentDirectory,
    LPSTARTUPINFOW lpStartupInfo,
    LPPROCESS_INFORMATION lpProcessInformation
) {
    auto& config = Core::Config::Instance();
    
    // 添加 CREATE_SUSPENDED 标志以便注入
    DWORD modifiedFlags = dwCreationFlags;
    bool needInject = config.childInjection && !(dwCreationFlags & CREATE_SUSPENDED);
    
    if (needInject) {
        modifiedFlags |= CREATE_SUSPENDED;
    }
    
    // 调用原始函数创建进程
    BOOL result = fpCreateProcessW(
        lpApplicationName, lpCommandLine,
        lpProcessAttributes, lpThreadAttributes,
        bInheritHandles, modifiedFlags,
        lpEnvironment, lpCurrentDirectory,
        lpStartupInfo, lpProcessInformation
    );
    
    if (result && needInject && lpProcessInformation) {
        // 先提取进程名用于过滤检查
        std::string appName = "Unknown";
        LPCWSTR targetStr = lpApplicationName ? lpApplicationName : lpCommandLine;
        if (targetStr) {
             int len = WideCharToMultiByte(CP_ACP, 0, targetStr, -1, NULL, 0, NULL, NULL);
             if (len > 0) {
                 std::vector<char> buf(len);
                 WideCharToMultiByte(CP_ACP, 0, targetStr, -1, buf.data(), len, NULL, NULL);
                 appName = buf.data();
                 // 简单处理：提取文件名
                 size_t lastSlash = appName.find_last_of("\\/");
                 if (lastSlash != std::string::npos) appName = appName.substr(lastSlash + 1);
                 // 去掉可能的引号
                 if (!appName.empty() && appName.front() == '\"') appName.erase(0, 1);
                 if (!appName.empty() && appName.back() == '\"') appName.pop_back(); 
                 // 再次过滤可能的参数（针对 lpCommandLine）
                 size_t firstSpace = appName.find(' ');
                 if (firstSpace != std::string::npos) appName = appName.substr(0, firstSpace);
             }
        }
        
        // 检查是否在目标进程列表中
        if (!config.ShouldInject(appName)) {
            bool shouldLog = false;
            {
                std::lock_guard<std::mutex> lock(g_loggedSkipProcessesMtx);
                if (g_loggedSkipProcesses.size() >= kMaxLoggedSkipProcesses) {
                    // 达到上限时清空，避免无限增长
                    g_loggedSkipProcesses.clear();
                }
                if (g_loggedSkipProcesses.find(appName) == g_loggedSkipProcesses.end()) {
                    g_loggedSkipProcesses[appName] = true;
                    shouldLog = true;
                }
            }
            if (shouldLog) {
                Core::Logger::Info("[跳过] 非目标进程(仅首次记录): " + appName +
                                  " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ")");
            }
            // 恢复进程（不注入）
            if (!(dwCreationFlags & CREATE_SUSPENDED)) {
                ResumeThread(lpProcessInformation->hThread);
            }
        } else {
            Core::Logger::Info("拦截到进程创建，准备注入 DLL...");
            
            // 注入 DLL 到子进程
            std::wstring dllPath = Injection::ProcessInjector::GetCurrentDllPath();
            if (!dllPath.empty()) {
                Injection::ProcessInjector::InjectDll(lpProcessInformation->hProcess, dllPath);
                Core::Logger::Info("[成功] 已注入目标进程: " + appName + " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ") - 父子关系建立");
            }
            
            // 如果原始调用没有要求挂起，则恢复进程
            if (!(dwCreationFlags & CREATE_SUSPENDED)) {
                ResumeThread(lpProcessInformation->hThread);
            }
        }
    }
    
    return result;
}

// ============= Phase 3: send/recv Hook =============

int WSAAPI DetourSend(SOCKET s, const char* buf, int len, int flags) {
    // 流量监控日志
    Network::TrafficMonitor::Instance().LogSend(s, buf, len);
    return fpSend(s, buf, len, flags);
}

int WSAAPI DetourRecv(SOCKET s, char* buf, int len, int flags) {
    int result = fpRecv(s, buf, len, flags);
    if (result > 0) {
        // 流量监控日志 (仅记录实际接收的数据)
        Network::TrafficMonitor::Instance().LogRecv(s, buf, result);
    }
    return result;
}

int WSAAPI DetourWSASend(
    SOCKET s, LPWSABUF lpBuffers, DWORD dwBufferCount,
    LPDWORD lpNumberOfBytesSent, DWORD dwFlags,
    LPWSAOVERLAPPED lpOverlapped,
    LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine
) {
    // 流量监控日志 (记录第一个缓冲区)
    if (lpBuffers && dwBufferCount > 0) {
        Network::TrafficMonitor::Instance().LogSend(s, lpBuffers[0].buf, lpBuffers[0].len);
    }
    return fpWSASend(s, lpBuffers, dwBufferCount, lpNumberOfBytesSent, dwFlags, lpOverlapped, lpCompletionRoutine);
}

int WSAAPI DetourWSARecv(
    SOCKET s, LPWSABUF lpBuffers, DWORD dwBufferCount,
    LPDWORD lpNumberOfBytesRecvd, LPDWORD lpFlags,
    LPWSAOVERLAPPED lpOverlapped,
    LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine
) {
    int result = fpWSARecv(s, lpBuffers, dwBufferCount, lpNumberOfBytesRecvd, lpFlags, lpOverlapped, lpCompletionRoutine);
    // 注意：异步操作无法立即获取数据，仅记录同步接收
    if (result == 0 && lpNumberOfBytesRecvd && *lpNumberOfBytesRecvd > 0 && lpBuffers && dwBufferCount > 0) {
        Network::TrafficMonitor::Instance().LogRecv(s, lpBuffers[0].buf, *lpNumberOfBytesRecvd);
    }
    return result;
}

// ============= Hook 管理 =============

namespace Hooks {
    void Install() {
        if (MH_Initialize() != MH_OK) {
            Core::Logger::Error("MinHook 初始化失败");
            return;
        }
        
        // ===== Phase 1: 网络 Hooks =====
        
        // Hook connect
        if (MH_CreateHookApi(L"ws2_32.dll", "connect", 
                             (LPVOID)DetourConnect, (LPVOID*)&fpConnect) != MH_OK) {
            Core::Logger::Error("Hook connect 失败");
        }
        
        // Hook WSAConnect
        if (MH_CreateHookApi(L"ws2_32.dll", "WSAConnect", 
                             (LPVOID)DetourWSAConnect, (LPVOID*)&fpWSAConnect) != MH_OK) {
            Core::Logger::Error("Hook WSAConnect 失败");
        }
        
        // Hook getaddrinfo
        if (MH_CreateHookApi(L"ws2_32.dll", "getaddrinfo", 
                             (LPVOID)DetourGetAddrInfo, (LPVOID*)&fpGetAddrInfo) != MH_OK) {
            Core::Logger::Error("Hook getaddrinfo 失败");
        }
        
        // Hook GetAddrInfoW
        if (MH_CreateHookApi(L"ws2_32.dll", "GetAddrInfoW", 
                             (LPVOID)DetourGetAddrInfoW, (LPVOID*)&fpGetAddrInfoW) != MH_OK) {
            Core::Logger::Error("Hook GetAddrInfoW 失败");
        }
        
        // Hook WSAConnectByNameA/W
        if (MH_CreateHookApi(L"ws2_32.dll", "WSAConnectByNameA", 
                             (LPVOID)DetourWSAConnectByNameA, (LPVOID*)&fpWSAConnectByNameA) != MH_OK) {
            Core::Logger::Error("Hook WSAConnectByNameA 失败");
        }
        if (MH_CreateHookApi(L"ws2_32.dll", "WSAConnectByNameW", 
                             (LPVOID)DetourWSAConnectByNameW, (LPVOID*)&fpWSAConnectByNameW) != MH_OK) {
            Core::Logger::Error("Hook WSAConnectByNameW 失败");
        }
        
        // Hook WSAIoctl (用于捕获 ConnectEx)
        if (MH_CreateHookApi(L"ws2_32.dll", "WSAIoctl", 
                             (LPVOID)DetourWSAIoctl, (LPVOID*)&fpWSAIoctl) != MH_OK) {
            Core::Logger::Error("Hook WSAIoctl 失败");
        }
        
        // Hook WSAGetOverlappedResult (ConnectEx 完成握手)
        if (MH_CreateHookApi(L"ws2_32.dll", "WSAGetOverlappedResult", 
                             (LPVOID)DetourWSAGetOverlappedResult, (LPVOID*)&fpWSAGetOverlappedResult) != MH_OK) {
            Core::Logger::Error("Hook WSAGetOverlappedResult 失败");
        }
        
        // ===== Phase 2: 进程创建 Hook =====
        
        // Hook CreateProcessW
        if (MH_CreateHookApi(L"kernel32.dll", "CreateProcessW",
                             (LPVOID)DetourCreateProcessW, (LPVOID*)&fpCreateProcessW) != MH_OK) {
            Core::Logger::Error("Hook CreateProcessW 失败");
        }
        
        // Hook GetQueuedCompletionStatus (ConnectEx 完成握手)
        if (MH_CreateHookApi(L"kernel32.dll", "GetQueuedCompletionStatus",
                             (LPVOID)DetourGetQueuedCompletionStatus, (LPVOID*)&fpGetQueuedCompletionStatus) != MH_OK) {
            Core::Logger::Error("Hook GetQueuedCompletionStatus 失败");
        }
        
        // Hook GetQueuedCompletionStatusEx (批量 IOCP - Chromium/Rust/Go 等现代应用必需)
        if (MH_CreateHookApi(L"kernel32.dll", "GetQueuedCompletionStatusEx",
                             (LPVOID)DetourGetQueuedCompletionStatusEx, (LPVOID*)&fpGetQueuedCompletionStatusEx) != MH_OK) {
            Core::Logger::Error("Hook GetQueuedCompletionStatusEx 失败");
        }
        
        // ===== Phase 3: 流量监控 Hooks =====
        
        // Hook send
        if (MH_CreateHookApi(L"ws2_32.dll", "send",
                             (LPVOID)DetourSend, (LPVOID*)&fpSend) != MH_OK) {
            Core::Logger::Error("Hook send 失败");
        }
        
        // Hook recv
        if (MH_CreateHookApi(L"ws2_32.dll", "recv",
                             (LPVOID)DetourRecv, (LPVOID*)&fpRecv) != MH_OK) {
            Core::Logger::Error("Hook recv 失败");
        }
        
        // Hook WSASend
        if (MH_CreateHookApi(L"ws2_32.dll", "WSASend",
                             (LPVOID)DetourWSASend, (LPVOID*)&fpWSASend) != MH_OK) {
            Core::Logger::Error("Hook WSASend 失败");
        }
        
        // Hook WSARecv
        if (MH_CreateHookApi(L"ws2_32.dll", "WSARecv",
                             (LPVOID)DetourWSARecv, (LPVOID*)&fpWSARecv) != MH_OK) {
            Core::Logger::Error("Hook WSARecv 失败");
        }
        
        if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
            Core::Logger::Error("启用 Hooks 失败");
        } else {
            Core::Logger::Info("所有 API Hook 安装成功 (Phase 1-3)");
        }
    }
    
    void Uninstall() {
        {
            // 清理未完成的 ConnectEx 上下文，避免卸载后残留
            std::lock_guard<std::mutex> lock(g_connectExMtx);
            g_connectExPending.clear();
        }
        MH_DisableHook(MH_ALL_HOOKS);
        MH_Uninitialize();
    }
}
