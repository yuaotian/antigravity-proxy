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
#include <atomic>
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
typedef struct hostent* (WSAAPI *gethostbyname_t)(const char* name);
typedef int (WSAAPI *getaddrinfo_t)(PCSTR, PCSTR, const ADDRINFOA*, PADDRINFOA*);
typedef int (WSAAPI *getaddrinfoW_t)(PCWSTR, PCWSTR, const ADDRINFOW*, PADDRINFOW*);
typedef int (WSAAPI *send_t)(SOCKET, const char*, int, int);
typedef int (WSAAPI *recv_t)(SOCKET, char*, int, int);
typedef int (WSAAPI *sendto_t)(SOCKET, const char*, int, int, const struct sockaddr*, int);
typedef int (WSAAPI *closesocket_t)(SOCKET);
typedef int (WSAAPI *shutdown_t)(SOCKET, int);
typedef int (WSAAPI *WSASend_t)(SOCKET, LPWSABUF, DWORD, LPDWORD, DWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef int (WSAAPI *WSARecv_t)(SOCKET, LPWSABUF, DWORD, LPDWORD, LPDWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef int (WSAAPI *WSASendTo_t)(SOCKET, LPWSABUF, DWORD, LPDWORD, DWORD, const struct sockaddr*, int, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef BOOL (WSAAPI *WSAConnectByNameA_t)(SOCKET, LPCSTR, LPCSTR, LPDWORD, LPSOCKADDR, LPDWORD, LPSOCKADDR, const struct timeval*, LPWSAOVERLAPPED);
typedef BOOL (WSAAPI *WSAConnectByNameW_t)(SOCKET, LPWSTR, LPWSTR, LPDWORD, LPSOCKADDR, LPDWORD, LPSOCKADDR, const struct timeval*, LPWSAOVERLAPPED);
typedef int (WSAAPI *WSAIoctl_t)(SOCKET, DWORD, LPVOID, DWORD, LPVOID, DWORD, LPDWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef BOOL (WSAAPI *WSAGetOverlappedResult_t)(SOCKET, LPWSAOVERLAPPED, LPDWORD, BOOL, LPDWORD);
typedef BOOL (WINAPI *GetQueuedCompletionStatus_t)(HANDLE, LPDWORD, PULONG_PTR, LPOVERLAPPED*, DWORD);
typedef BOOL (WINAPI *CreateProcessW_t)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
typedef BOOL (WINAPI *CreateProcessA_t)(LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION);
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
gethostbyname_t fpGetHostByName = NULL;
getaddrinfo_t fpGetAddrInfo = NULL;
getaddrinfoW_t fpGetAddrInfoW = NULL;
send_t fpSend = NULL;
recv_t fpRecv = NULL;
sendto_t fpSendTo = NULL;
closesocket_t fpCloseSocket = NULL;
shutdown_t fpShutdown = NULL;
WSASend_t fpWSASend = NULL;
WSARecv_t fpWSARecv = NULL;
WSASendTo_t fpWSASendTo = NULL;
WSAConnectByNameA_t fpWSAConnectByNameA = NULL;
WSAConnectByNameW_t fpWSAConnectByNameW = NULL;
WSAIoctl_t fpWSAIoctl = NULL;
WSAGetOverlappedResult_t fpWSAGetOverlappedResult = NULL;
GetQueuedCompletionStatus_t fpGetQueuedCompletionStatus = NULL;
LPFN_CONNECTEX fpConnectEx = NULL;
CreateProcessW_t fpCreateProcessW = NULL;
CreateProcessA_t fpCreateProcessA = NULL;
GetQueuedCompletionStatusEx_t fpGetQueuedCompletionStatusEx = NULL; // 批量 IOCP 事件获取

// ============= 辅助函数 =============

// 保存原始目标地址用于 SOCKS5 握手
struct OriginalTarget {
    std::string host;
    uint16_t port;
};

// 线程本地存储，保存当前连接的原始目标
thread_local OriginalTarget g_currentTarget;

// 记录“socket -> 原始目标”的映射，用于在 closesocket/shutdown 时输出更可复盘的断开日志
// 设计意图：满足“连接断开过程”日志需求，同时避免在 close 时重复做高成本解析。
struct SocketTargetInfo {
    std::string host;
    uint16_t port = 0;
    ULONGLONG establishedTick = 0;
};
static std::unordered_map<SOCKET, SocketTargetInfo> g_socketTargets;
static std::mutex g_socketTargetsMtx;

static void RememberSocketTarget(SOCKET s, const std::string& host, uint16_t port) {
    if (s == INVALID_SOCKET || host.empty() || port == 0) return;
    std::lock_guard<std::mutex> lock(g_socketTargetsMtx);
    g_socketTargets[s] = SocketTargetInfo{host, port, GetTickCount64()};
}

static bool TryGetSocketTarget(SOCKET s, SocketTargetInfo* out) {
    if (!out || s == INVALID_SOCKET) return false;
    std::lock_guard<std::mutex> lock(g_socketTargetsMtx);
    auto it = g_socketTargets.find(s);
    if (it == g_socketTargets.end()) return false;
    *out = it->second;
    return true;
}

static void ForgetSocketTarget(SOCKET s) {
    if (s == INVALID_SOCKET) return;
    std::lock_guard<std::mutex> lock(g_socketTargetsMtx);
    g_socketTargets.erase(s);
}

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
// ConnectEx 在不同 Provider 下可能返回不同函数指针，这里按 CatalogEntryId 记录各自的 trampoline
static std::unordered_map<DWORD, LPFN_CONNECTEX> g_connectExOriginalByCatalog;
// ConnectEx 目标函数指针可能被多个 Provider 复用，这里按“目标函数地址”记录 trampoline，便于复用与补全 Catalog 映射
static std::unordered_map<void*, LPFN_CONNECTEX> g_connectExTrampolineByTarget;
static const ULONGLONG kConnectExPendingTtlMs = 60000; // 超过 60 秒的上下文视为过期

// 为了避免日志被大量非目标进程淹没，这里仅首次记录“跳过注入”的进程名
static std::unordered_map<std::string, bool> g_loggedSkipProcesses;
static std::mutex g_loggedSkipProcessesMtx;
static const size_t kMaxLoggedSkipProcesses = 256; // 限制缓存规模，避免无限增长

// 运行时配置摘要仅打印一次，方便收集“别人不行”的现场信息
static std::once_flag g_runtimeConfigLogOnce;

static std::string WideToUtf8(PCWSTR input) {
    if (!input) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, input, -1, NULL, 0, NULL, NULL);
    if (len <= 0) return "";
    std::string result(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, input, -1, &result[0], len, NULL, NULL);
    if (!result.empty() && result.back() == '\0') result.pop_back();
    return result;
}

// 获取 socket 类型（SOCK_STREAM / SOCK_DGRAM），用于避免误把 UDP/QUIC 当成 TCP 走代理
static bool TryGetSocketType(SOCKET s, int* outType) {
    if (!outType) return false;
    *outType = 0;
    int soType = 0;
    int optLen = sizeof(soType);
    if (getsockopt(s, SOL_SOCKET, SO_TYPE, (char*)&soType, &optLen) != 0) {
        return false;
    }
    *outType = soType;
    return true;
}

static bool IsStreamSocket(SOCKET s) {
    int soType = 0;
    if (!TryGetSocketType(s, &soType)) {
        // 获取失败时不改变行为：默认认为是 SOCK_STREAM，避免引入新的兼容性风险
        return true;
    }
    return soType == SOCK_STREAM;
}

// 获取当前 socket 的 Provider CatalogEntryId，用于在多 Provider 环境下正确调用对应的 ConnectEx trampoline
static bool TryGetSocketCatalogEntryId(SOCKET s, DWORD* outCatalogEntryId) {
    if (!outCatalogEntryId) return false;
    *outCatalogEntryId = 0;
    WSAPROTOCOL_INFOA info{};
    int optLen = sizeof(info);
    if (getsockopt(s, SOL_SOCKET, SO_PROTOCOL_INFOA, (char*)&info, &optLen) != 0) {
        return false;
    }
    *outCatalogEntryId = info.dwCatalogEntryId;
    return true;
}

static LPFN_CONNECTEX GetOriginalConnectExForSocket(SOCKET s) {
    static std::once_flag s_catalogMissingOnce;
    static std::once_flag s_mapMissingOnce;

    DWORD catalogId = 0;
    if (TryGetSocketCatalogEntryId(s, &catalogId)) {
        {
            std::lock_guard<std::mutex> lock(g_connectExHookMtx);
            auto it = g_connectExOriginalByCatalog.find(catalogId);
            if (it != g_connectExOriginalByCatalog.end() && it->second) {
                return it->second;
            }
        }
        if (fpConnectEx) {
            // 只记录一次，避免刷屏；用于定位“某些 Provider 的 ConnectEx 没被正确记录”的现场
            std::call_once(s_mapMissingOnce, [catalogId]() {
                Core::Logger::Warn("ConnectEx: 未找到 CatalogEntryId=" + std::to_string(catalogId) +
                                   " 的 trampoline 映射，使用兜底实现");
            });
        }
        return fpConnectEx;
    }
    // 兜底：兼容单 Provider 场景（或获取 Catalog 失败）
    if (fpConnectEx) {
        std::call_once(s_catalogMissingOnce, []() {
            Core::Logger::Warn("ConnectEx: 无法获取 socket 的 CatalogEntryId，使用兜底实现");
        });
    }
    return fpConnectEx;
}

static void LogRuntimeConfigSummaryOnce() {
    std::call_once(g_runtimeConfigLogOnce, []() {
        const auto& config = Core::Config::Instance();

        std::string ports;
        if (config.rules.allowed_ports.empty()) {
            ports = "空(=全部)";
        } else {
            for (size_t i = 0; i < config.rules.allowed_ports.size(); i++) {
                if (i != 0) ports += ",";
                ports += std::to_string(config.rules.allowed_ports[i]);
            }
        }

        Core::Logger::Info(
            "配置摘要: proxy=" + config.proxy.type + "://" + config.proxy.host + ":" + std::to_string(config.proxy.port) +
            ", fake_ip=" + std::string(config.fakeIp.enabled ? "开" : "关") +
            ", cidr=" + config.fakeIp.cidr +
            ", dns_mode=" + (config.rules.dns_mode.empty() ? "(空)" : config.rules.dns_mode) +
            ", ipv6_mode=" + (config.rules.ipv6_mode.empty() ? "(空)" : config.rules.ipv6_mode) +
            ", udp_mode=" + (config.rules.udp_mode.empty() ? "(空)" : config.rules.udp_mode) +
            ", allowed_ports=" + ports +
            ", timeout(connect/send/recv)=" + std::to_string(config.timeout.connect_ms) + "/" + std::to_string(config.timeout.send_ms) + "/" +
                std::to_string(config.timeout.recv_ms) +
            ", child_injection=" + std::string(config.childInjection ? "开" : "关") +
            ", traffic_logging=" + std::string(config.trafficLogging ? "开" : "关")
        );
        
        // 增加系统环境信息，便于诊断不同环境下的兼容性问题
        WSADATA wsaData{};
        if (WSAStartup(MAKEWORD(2, 2), &wsaData) == 0) {
            Core::Logger::Info("系统环境: Winsock版本=" + 
                std::to_string(LOBYTE(wsaData.wVersion)) + "." + std::to_string(HIBYTE(wsaData.wVersion)) +
                ", 最高版本=" + std::to_string(LOBYTE(wsaData.wHighVersion)) + "." + std::to_string(HIBYTE(wsaData.wHighVersion)) +
                ", MaxSockets=" + std::to_string(wsaData.iMaxSockets) +
                ", 描述=" + std::string(wsaData.szDescription));
            WSACleanup();
        }
    });
}

static bool ResolveOriginalTarget(const sockaddr* name, std::string* host, uint16_t* port) {
    if (!name) return false;
    if (name->sa_family == AF_INET) {
        auto* addr = (sockaddr_in*)name;
        if (port) *port = ntohs(addr->sin_port);
        if (host) {
                if (Network::FakeIP::Instance().IsFakeIP(addr->sin_addr.s_addr)) {
                    std::string domain = Network::FakeIP::Instance().GetDomain(addr->sin_addr.s_addr);
                    if (domain.empty()) {
                        std::string ipStr = Network::FakeIP::IpToString(addr->sin_addr.s_addr);
                        // FakeIP::GetDomain 已在未命中时输出告警；这里降级为调试，避免重复刷屏
                        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                            Core::Logger::Debug("FakeIP: 命中但映射缺失, ip=" + ipStr);
                        }
                        *host = ipStr;
                    } else {
                        *host = domain;
                    }
            } else {
                *host = Network::FakeIP::IpToString(addr->sin_addr.s_addr);
            }
        }
        return true;
    }
    if (name->sa_family == AF_INET6) {
        auto* addr6 = (sockaddr_in6*)name;
        if (port) *port = ntohs(addr6->sin6_port);
        if (host) {
            if (IN6_IS_ADDR_V4MAPPED(&addr6->sin6_addr)) {
                // IPv4-mapped IPv6 继续走 FakeIP 映射，保持域名还原能力
                in_addr addr4{};
                const unsigned char* raw = reinterpret_cast<const unsigned char*>(&addr6->sin6_addr);
                memcpy(&addr4, raw + 12, sizeof(addr4));
                if (Network::FakeIP::Instance().IsFakeIP(addr4.s_addr)) {
                    std::string domain = Network::FakeIP::Instance().GetDomain(addr4.s_addr);
                    if (domain.empty()) {
                        std::string ipStr = Network::FakeIP::IpToString(addr4.s_addr);
                        // FakeIP::GetDomain 已在未命中时输出告警；这里降级为调试，避免重复刷屏
                        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                            Core::Logger::Debug("FakeIP(v4-mapped): 命中但映射缺失, ip=" + ipStr);
                        }
                        *host = ipStr;
                    } else {
                        *host = domain;
                    }
                } else {
                    *host = Network::FakeIP::IpToString(addr4.s_addr);
                }
            } else {
                char buf[INET6_ADDRSTRLEN] = {};
                if (!inet_ntop(AF_INET6, &addr6->sin6_addr, buf, sizeof(buf))) {
                    *host = "";
                } else {
                    *host = std::string(buf);
                }
            }
        }
        return true;
    }
    return false;
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

// 从 sockaddr 提取端口（仅用于策略判断/日志；失败时返回 false）
static bool TryGetSockaddrPort(const sockaddr* addr, uint16_t* outPort) {
    if (!outPort) return false;
    *outPort = 0;
    if (!addr) return false;
    if (addr->sa_family == AF_INET) {
        const auto* addr4 = (const sockaddr_in*)addr;
        *outPort = ntohs(addr4->sin_port);
        return true;
    }
    if (addr->sa_family == AF_INET6) {
        const auto* addr6 = (const sockaddr_in6*)addr;
        *outPort = ntohs(addr6->sin6_port);
        return true;
    }
    return false;
}

// 判断 sockaddr 是否为回环地址（127.0.0.0/8 或 ::1 或 v4-mapped 127.0.0.0/8）
static bool IsSockaddrLoopback(const sockaddr* addr) {
    if (!addr) return false;
    if (addr->sa_family == AF_INET) {
        const auto* addr4 = (const sockaddr_in*)addr;
        const uint32_t ip = ntohl(addr4->sin_addr.s_addr);
        return ((ip >> 24) == 127);
    }
    if (addr->sa_family == AF_INET6) {
        const auto* addr6 = (const sockaddr_in6*)addr;
        if (IN6_IS_ADDR_LOOPBACK(&addr6->sin6_addr)) return true;
        if (IN6_IS_ADDR_V4MAPPED(&addr6->sin6_addr)) {
            in_addr addr4{};
            const unsigned char* raw = reinterpret_cast<const unsigned char*>(&addr6->sin6_addr);
            memcpy(&addr4, raw + 12, sizeof(addr4));
            const uint32_t ip = ntohl(addr4.s_addr);
            return ((ip >> 24) == 127);
        }
    }
    return false;
}

// UDP 强阻断策略会触发大量重试（尤其是 QUIC），这里做简单限流，避免日志/IO 影响性能
static bool ShouldLogUdpBlock() {
    static std::atomic<int> s_logCount{0};
    const int n = s_logCount.fetch_add(1, std::memory_order_relaxed);
    if (n < 20) return true; // 仅前 20 次输出详细阻断日志
    if (n == 20) {
        Core::Logger::Warn("UDP 阻断日志过多，后续将仅在 [调试] 级别输出（避免 QUIC 重试导致日志/性能问题；注意：WSA错误码=10051 为策略阻断返回）");
    }
    return Core::Logger::IsEnabled(Core::LogLevel::Debug);
}

// 从 socket 读取当前端点信息（仅用于日志；失败时返回空字符串）
static std::string GetPeerEndpoint(SOCKET s) {
    sockaddr_storage ss{};
    int len = (int)sizeof(ss);
    if (getpeername(s, (sockaddr*)&ss, &len) != 0) return "";
    return SockaddrToString((sockaddr*)&ss);
}

static std::string GetLocalEndpoint(SOCKET s) {
    sockaddr_storage ss{};
    int len = (int)sizeof(ss);
    if (getsockname(s, (sockaddr*)&ss, &len) != 0) return "";
    return SockaddrToString((sockaddr*)&ss);
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

static bool BuildProxyAddrV6(const Core::ProxyConfig& proxy, sockaddr_in6* proxyAddr, const sockaddr_in6* baseAddr) {
    if (!proxyAddr) return false;
    if (baseAddr) {
        *proxyAddr = *baseAddr;
    } else {
        memset(proxyAddr, 0, sizeof(sockaddr_in6));
    }
    proxyAddr->sin6_family = AF_INET6;
    
    in6_addr addr6{};
    if (inet_pton(AF_INET6, proxy.host.c_str(), &addr6) == 1) {
        proxyAddr->sin6_addr = addr6;
    } else {
        in_addr addr4{};
        if (inet_pton(AF_INET, proxy.host.c_str(), &addr4) == 1) {
            // IPv4 代理地址映射为 IPv6，兼容双栈 socket
            unsigned char* bytes = reinterpret_cast<unsigned char*>(&proxyAddr->sin6_addr);
            memset(bytes, 0, 16);
            bytes[10] = 0xff;
            bytes[11] = 0xff;
            memcpy(bytes + 12, &addr4, sizeof(addr4));
        } else {
            // 优先解析 IPv6，失败则回退 IPv4 并映射
            addrinfo hints{};
            hints.ai_family = AF_INET6;
            hints.ai_socktype = SOCK_STREAM;
            hints.ai_protocol = IPPROTO_TCP;
            addrinfo* res = nullptr;
            int rc = fpGetAddrInfo ? fpGetAddrInfo(proxy.host.c_str(), nullptr, &hints, &res)
                                   : getaddrinfo(proxy.host.c_str(), nullptr, &hints, &res);
            if (rc == 0 && res) {
                proxyAddr->sin6_addr = ((sockaddr_in6*)res->ai_addr)->sin6_addr;
                freeaddrinfo(res);
            } else {
                if (res) freeaddrinfo(res);
                addrinfo hints4{};
                hints4.ai_family = AF_INET;
                hints4.ai_socktype = SOCK_STREAM;
                hints4.ai_protocol = IPPROTO_TCP;
                rc = fpGetAddrInfo ? fpGetAddrInfo(proxy.host.c_str(), nullptr, &hints4, &res)
                                   : getaddrinfo(proxy.host.c_str(), nullptr, &hints4, &res);
                if (rc != 0 || !res) {
                    Core::Logger::Error("代理地址解析失败: " + proxy.host + ", 错误码=" + std::to_string(rc));
                    return false;
                }
                in_addr resolved4 = ((sockaddr_in*)res->ai_addr)->sin_addr;
                freeaddrinfo(res);
                unsigned char* bytes = reinterpret_cast<unsigned char*>(&proxyAddr->sin6_addr);
                memset(bytes, 0, 16);
                bytes[10] = 0xff;
                bytes[11] = 0xff;
                memcpy(bytes + 12, &resolved4, sizeof(resolved4));
            }
        }
    }
    proxyAddr->sin6_port = htons(proxy.port);
    return true;
}

// 按指定地址族解析目标地址
static bool ResolveNameToAddrWithFamily(const std::string& node, const std::string& service, int family,
                                        sockaddr_storage* out, int* outLen, int* outErr) {
    if (!out || !outLen) return false;
    addrinfo hints{};
    hints.ai_family = family;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    addrinfo* res = nullptr;
    const char* serviceStr = service.empty() ? nullptr : service.c_str();
    int rc = fpGetAddrInfo ? fpGetAddrInfo(node.c_str(), serviceStr, &hints, &res)
                           : getaddrinfo(node.c_str(), serviceStr, &hints, &res);
    if (outErr) *outErr = rc;
    if (rc != 0 || !res) {
        if (res) freeaddrinfo(res);
        return false;
    }
    if (res->ai_addrlen <= 0 || res->ai_addrlen > sizeof(sockaddr_storage)) {
        freeaddrinfo(res);
        if (outErr) *outErr = EAI_FAIL;
        return false;
    }
    memset(out, 0, sizeof(sockaddr_storage));
    memcpy(out, res->ai_addr, res->ai_addrlen);
    *outLen = (int)res->ai_addrlen;
    freeaddrinfo(res);
    return true;
}

// 解析目标域名为地址，供 WSAConnectByName 走代理（IPv6 允许时优先 IPv6）
static bool ResolveNameToAddr(const std::string& node, const std::string& service, const std::string& ipv6Mode,
                              sockaddr_storage* out, int* outLen) {
    if (!out || !outLen || node.empty()) return false;
    int lastErr = 0;
    const bool allowIpv6 = (ipv6Mode == "proxy" || ipv6Mode == "direct");
    if (allowIpv6) {
        if (ResolveNameToAddrWithFamily(node, service, AF_INET6, out, outLen, &lastErr)) {
            return true;
        }
    }
    if (ResolveNameToAddrWithFamily(node, service, AF_INET, out, outLen, &lastErr)) {
        return true;
    }
    Core::Logger::Error("目标地址解析失败: " + node + ", 错误码=" + std::to_string(lastErr));
    return false;
}

static bool DoProxyHandshake(SOCKET s, const std::string& host, uint16_t port) {
    // FIX-2: 预检确保 socket 已成功连接到代理服务器，避免在未连接的 socket 上发送数据
    sockaddr_storage peerAddr{};
    int peerLen = sizeof(peerAddr);
    if (getpeername(s, (sockaddr*)&peerAddr, &peerLen) != 0) {
        int err = WSAGetLastError();
        Core::Logger::Error("代理握手: socket 未连接, sock=" + std::to_string((unsigned long long)s) +
                            ", 目标=" + host + ":" + std::to_string(port) +
                            ", WSA错误码=" + std::to_string(err));
        WSASetLastError(WSAENOTCONN);
        return false;
    }

    auto& config = Core::Config::Instance();
    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        Core::Logger::Debug("代理握手: 开始, sock=" + std::to_string((unsigned long long)s) +
                            ", type=" + config.proxy.type +
                            ", 目标=" + host + ":" + std::to_string(port));
    }
    if (config.proxy.type == "socks5") {
        if (!Network::Socks5Client::Handshake(s, host, port)) {
            Core::Logger::Error("SOCKS5 握手失败, sock=" + std::to_string((unsigned long long)s) +
                                ", 目标=" + host + ":" + std::to_string(port));
            WSASetLastError(WSAECONNREFUSED);
            return false;
        }
    } else if (config.proxy.type == "http") {
        if (!Network::HttpConnectClient::Handshake(s, host, port)) {
            Core::Logger::Error("HTTP CONNECT 握手失败, sock=" + std::to_string((unsigned long long)s) +
                                ", 目标=" + host + ":" + std::to_string(port));
            WSASetLastError(WSAECONNREFUSED);
            return false;
        }
    } else {
        Core::Logger::Error("未知代理类型: " + config.proxy.type +
                            ", sock=" + std::to_string((unsigned long long)s) +
                            ", 目标=" + host + ":" + std::to_string(port));
        WSASetLastError(WSAECONNREFUSED);
        return false;
    }

    // 记录 socket -> 原始目标映射，便于在断开时输出可复盘日志
    RememberSocketTarget(s, host, port);
    
    // 隧道就绪日志：始终打印，便于排查问题（如"隧道建立成功但后续不通"）
    Core::Logger::Info("代理隧道就绪: sock=" + std::to_string((unsigned long long)s) +
                       ", type=" + config.proxy.type +
                       ", 代理=" + config.proxy.host + ":" + std::to_string(config.proxy.port) +
                       ", 目标=" + host + ":" + std::to_string(port));
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

// ConnectEx 连接完成后更新上下文，避免 send 报 WSAENOTCONN
static bool UpdateConnectExContext(SOCKET s) {
    if (setsockopt(s, SOL_SOCKET, SO_UPDATE_CONNECT_CONTEXT, NULL, 0) != 0) {
        int err = WSAGetLastError();
        Core::Logger::Warn("ConnectEx: 更新连接上下文失败, sock=" + std::to_string((unsigned long long)s) +
                           ", WSA错误码=" + std::to_string(err));
    }
    int soErr = 0;
    int soErrLen = sizeof(soErr);
    if (getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&soErr, &soErrLen) == 0 && soErr != 0) {
        Core::Logger::Error("ConnectEx: 连接状态异常, sock=" + std::to_string((unsigned long long)s) +
                            ", SO_ERROR=" + std::to_string(soErr));
        WSASetLastError(soErr);
        return false;
    }
    return true;
}

static bool HandleConnectExCompletion(LPOVERLAPPED ovl, DWORD* outSentBytes) {
    if (outSentBytes) *outSentBytes = 0;
    ConnectExContext ctx{};
    if (!PopConnectExContext(ovl, &ctx)) return true;
    if (!UpdateConnectExContext(ctx.sock)) {
        return false;
    }
    if (!DoProxyHandshake(ctx.sock, ctx.host, ctx.port)) {
        return false;
    }
    if (ctx.sendBuf && ctx.sendLen > 0) {
        // 使用统一 SendAll，兼容非阻塞 socket / partial send
        auto& config = Core::Config::Instance();
        if (!Network::SocketIo::SendAll(ctx.sock, ctx.sendBuf, (int)ctx.sendLen, config.timeout.send_ms)) {
            int err = WSAGetLastError();
            Core::Logger::Error("ConnectEx 发送首包失败, sock=" + std::to_string((unsigned long long)ctx.sock) +
                                ", bytes=" + std::to_string((unsigned long long)ctx.sendLen) +
                                ", WSA错误码=" + std::to_string(err));
            WSASetLastError(err);
            return false;
        }
        if (ctx.bytesSent) {
            *ctx.bytesSent = (DWORD)ctx.sendLen;
        }
        if (outSentBytes) {
            *outSentBytes = (DWORD)ctx.sendLen;
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
    LogRuntimeConfigSummaryOnce();
    
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
    if (name->sa_family == AF_INET6 && namelen < (int)sizeof(sockaddr_in6)) {
        WSASetLastError(WSAEINVAL);
        return SOCKET_ERROR;
    }

    // Hook 调用日志：仅在 Debug 下记录参数，避免热路径字符串拼接开销
    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        const std::string dst = SockaddrToString(name);
        Core::Logger::Debug(std::string(isWsa ? "WSAConnect" : "connect") +
                            ": 调用, sock=" + std::to_string((unsigned long long)s) +
                            ", dst=" + (dst.empty() ? "(未知)" : dst) +
                            ", family=" + std::to_string((int)name->sa_family) +
                            ", namelen=" + std::to_string(namelen));
    }
    
    // 仅对 TCP (SOCK_STREAM) 做代理，避免误伤 UDP/QUIC 等
    if (config.proxy.port != 0 && !IsStreamSocket(s)) {
        int soType = 0;
        TryGetSocketType(s, &soType);

        // UDP 强阻断：默认阻断 UDP（除 DNS/loopback 例外），强制应用回退到 TCP 再走代理
        // 设计意图：解决国内环境 QUIC/HTTP3(UDP) 绕过代理导致“看似已建隧道但仍不可用”的问题。
        if (soType == SOCK_DGRAM && config.rules.udp_mode == "block") {
            uint16_t dstPort = 0;
            const bool hasPort = TryGetSockaddrPort(name, &dstPort);
            const bool allowUdp = IsSockaddrLoopback(name) || (hasPort && dstPort == 53);
            if (!allowUdp) {
                const int err = WSAENETUNREACH;
                if (ShouldLogUdpBlock()) {
                    const std::string api = isWsa ? "WSAConnect" : "connect";
                    const std::string dst = SockaddrToString(name);
                    Core::Logger::Warn(api + ": 已阻止 UDP 连接(策略: udp_mode=block, 说明: 禁用 QUIC/HTTP3), sock=" + std::to_string((unsigned long long)s) +
                                       (dst.empty() ? "" : ", dst=" + dst) +
                                       (hasPort ? (", port=" + std::to_string(dstPort)) : std::string("")) +
                                       ", WSA错误码=" + std::to_string(err));
                }
                WSASetLastError(err);
                return SOCKET_ERROR;
            }
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                const std::string dst = SockaddrToString(name);
                Core::Logger::Debug(std::string(isWsa ? "WSAConnect" : "connect") +
                                    ": UDP 直连已放行(例外), sock=" + std::to_string((unsigned long long)s) +
                                    (dst.empty() ? "" : ", dst=" + dst));
            }
            return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
        }

        // 其他非 SOCK_STREAM 类型保持直连；仅在 Debug 下记录，避免刷屏影响性能
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            const std::string dst = SockaddrToString(name);
            Core::Logger::Debug(std::string(isWsa ? "WSAConnect" : "connect") +
                                ": 非 SOCK_STREAM 直连, sock=" + std::to_string((unsigned long long)s) +
                                ", soType=" + std::to_string(soType) +
                                (dst.empty() ? "" : ", dst=" + dst));
        }
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }

    if (name->sa_family == AF_INET6) {
        const auto* addr6 = (const sockaddr_in6*)name;
        const bool isV4Mapped = IN6_IS_ADDR_V4MAPPED(&addr6->sin6_addr);

        // v4-mapped IPv6 本质是 IPv4 连接：不应被 ipv6_mode 误伤（否则会影响 FakeIP v4-mapped 回填）
        if (!isV4Mapped) {
            std::string addrStr = SockaddrToString(name);
            if (config.proxy.port != 0) {
                const std::string& ipv6Mode = config.rules.ipv6_mode;
                if (ipv6Mode == "direct") {
                    Core::Logger::Info("IPv6 连接已直连(策略: direct), sock=" + std::to_string((unsigned long long)s) +
                                       ", family=" + std::to_string((int)name->sa_family) +
                                       (addrStr.empty() ? "" : ", addr=" + addrStr));
                    return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
                }
                if (ipv6Mode != "proxy") {
                    // 强制阻止 IPv6，避免绕过代理
                    Core::Logger::Warn("已阻止 IPv6 连接(策略: block), sock=" + std::to_string((unsigned long long)s) +
                                       ", family=" + std::to_string((int)name->sa_family) +
                                       (addrStr.empty() ? "" : ", addr=" + addrStr));
                    WSASetLastError(WSAEAFNOSUPPORT);
                    return SOCKET_ERROR;
                }
            } else {
                Core::Logger::Info("IPv6 连接已直连, sock=" + std::to_string((unsigned long long)s) +
                                   ", family=" + std::to_string((int)name->sa_family) +
                                   (addrStr.empty() ? "" : ", addr=" + addrStr));
                return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
            }
        }
    } else if (name->sa_family != AF_INET) {
        std::string addrStr = SockaddrToString(name);
        if (config.proxy.port != 0) {
            // 非 IPv4/IPv6 连接一律阻止，避免绕过代理
            Core::Logger::Warn("已阻止非 IPv4/IPv6 连接, sock=" + std::to_string((unsigned long long)s) +
                               ", family=" + std::to_string((int)name->sa_family) +
                               (addrStr.empty() ? "" : ", addr=" + addrStr));
            WSASetLastError(WSAEAFNOSUPPORT);
            return SOCKET_ERROR;
        }
        Core::Logger::Info("非 IPv4/IPv6 连接已直连, sock=" + std::to_string((unsigned long long)s) +
                           ", family=" + std::to_string((int)name->sa_family) +
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
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("BYPASS(loopback): sock=" + std::to_string((unsigned long long)s) +
                                ", target=" + originalHost + ":" + std::to_string(originalPort));
        }
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }
    
    // BYPASS: 如果目标端口就是代理端口，直连（防止代理自连接）
    if (IsProxySelfTarget(originalHost, originalPort, config.proxy)) {
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("BYPASS(proxy-self): sock=" + std::to_string((unsigned long long)s) +
                                ", target=" + originalHost + ":" + std::to_string(originalPort) +
                                ", proxy=" + config.proxy.host + ":" + std::to_string(config.proxy.port));
        }
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) : fpConnect(s, name, namelen);
    }
    
    // ============= 智能路由决策 =============
    // ROUTE-1: DNS 端口特殊处理 (解决 DNS 超时问题)
    if (originalPort == 53) {
        if (config.rules.dns_mode == "direct" || config.rules.dns_mode.empty()) {
            Core::Logger::Info("DNS 请求直连 (策略: direct), sock=" + std::to_string((unsigned long long)s) +
                               ", 目标: " + originalHost + ":53");
            return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) 
                         : fpConnect(s, name, namelen);
        }
        // dns_mode == "proxy" 则继续走后面的代理逻辑
        Core::Logger::Info("DNS 请求走代理 (策略: proxy), sock=" + std::to_string((unsigned long long)s) +
                           ", 目标: " + originalHost + ":53");
    }
    
    // ROUTE-2: 端口白名单过滤
    if (!config.rules.IsPortAllowed(originalPort)) {
        Core::Logger::Info("端口 " + std::to_string(originalPort) + " 不在白名单, sock=" + std::to_string((unsigned long long)s) +
                           ", 直连: " + originalHost);
        return isWsa ? fpWSAConnect(s, name, namelen, NULL, NULL, NULL, NULL) 
                     : fpConnect(s, name, namelen);
    }
    
    // 如果配置了代理
    if (config.proxy.port != 0) {
        Core::Logger::Info("正重定向 " + originalHost + ":" + std::to_string(originalPort) +
                           " 到代理, sock=" + std::to_string((unsigned long long)s));
        
        // 修改目标地址为代理服务器（按地址族构造）
        int result = 0;
        if (name->sa_family == AF_INET6) {
            sockaddr_in6 proxyAddr6{};
            if (!BuildProxyAddrV6(config.proxy, &proxyAddr6, (sockaddr_in6*)name)) {
                WSASetLastError(WSAEINVAL);
                return SOCKET_ERROR;
            }
            result = isWsa ?
                fpWSAConnect(s, (sockaddr*)&proxyAddr6, sizeof(proxyAddr6), NULL, NULL, NULL, NULL) :
                fpConnect(s, (sockaddr*)&proxyAddr6, sizeof(proxyAddr6));
        } else {
            sockaddr_in proxyAddr{};
            if (!BuildProxyAddr(config.proxy, &proxyAddr, (sockaddr_in*)name)) {
                WSASetLastError(WSAEINVAL);
                return SOCKET_ERROR;
            }
            result = isWsa ? 
                fpWSAConnect(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr), NULL, NULL, NULL, NULL) :
                fpConnect(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr));
        }
        
        if (result != 0) {
            int err = WSAGetLastError();
            if (err == WSAEWOULDBLOCK || err == WSAEINPROGRESS) {
                // 非阻塞 connect 需要等待连接完成
                if (!Network::SocketIo::WaitConnect(s, config.timeout.connect_ms)) {
                    int waitErr = WSAGetLastError();
                    Core::Logger::Error("连接代理服务器失败, sock=" + std::to_string((unsigned long long)s) +
                                        ", WSA错误码=" + std::to_string(waitErr));
                    return SOCKET_ERROR;
                }
            } else {
                Core::Logger::Error("连接代理服务器失败, sock=" + std::to_string((unsigned long long)s) +
                                    ", WSA错误码=" + std::to_string(err));
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

int WSAAPI DetourShutdown(SOCKET s, int how) {
    if (!fpShutdown) {
        WSASetLastError(WSAEINVAL);
        return SOCKET_ERROR;
    }

    SocketTargetInfo target{};
    const bool hasTarget = TryGetSocketTarget(s, &target);

    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        const std::string local = GetLocalEndpoint(s);
        const std::string peer = GetPeerEndpoint(s);
        const std::string targetStr = hasTarget
            ? (target.host + ":" + std::to_string(target.port))
            : std::string("(未知)");
        Core::Logger::Debug("shutdown: sock=" + std::to_string((unsigned long long)s) +
                            ", how=" + std::to_string(how) +
                            ", target=" + targetStr +
                            (local.empty() ? "" : ", local=" + local) +
                            (peer.empty() ? "" : ", peer=" + peer));
    }

    int rc = fpShutdown(s, how);
    if (rc == SOCKET_ERROR) {
        int err = WSAGetLastError();
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("shutdown: 失败, sock=" + std::to_string((unsigned long long)s) +
                                ", WSA错误码=" + std::to_string(err));
        }
        WSASetLastError(err);
    }
    return rc;
}

int WSAAPI DetourCloseSocket(SOCKET s) {
    if (!fpCloseSocket) {
        WSASetLastError(WSAEINVAL);
        return SOCKET_ERROR;
    }

    SocketTargetInfo target{};
    const bool hasTarget = TryGetSocketTarget(s, &target);

    std::string local;
    std::string peer;
    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        local = GetLocalEndpoint(s);
        peer = GetPeerEndpoint(s);
        const std::string targetStr = hasTarget
            ? (target.host + ":" + std::to_string(target.port))
            : std::string("(未知)");
        Core::Logger::Debug("closesocket: sock=" + std::to_string((unsigned long long)s) +
                            ", target=" + targetStr +
                            (local.empty() ? "" : ", local=" + local) +
                            (peer.empty() ? "" : ", peer=" + peer));
    }

    int rc = fpCloseSocket(s);
    if (rc == SOCKET_ERROR) {
        int err = WSAGetLastError();
        Core::Logger::Warn("closesocket: 失败, sock=" + std::to_string((unsigned long long)s) +
                           ", WSA错误码=" + std::to_string(err));
        WSASetLastError(err);
        return rc;
    }

    // 关闭成功后清理映射，避免句柄复用导致的误关联
    ForgetSocketTarget(s);

    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        Core::Logger::Debug("closesocket: 完成, sock=" + std::to_string((unsigned long long)s));
    }
    return rc;
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
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("拦截到域名解析: " + node);
            }
            // 分配虚拟 IP，并让原始 getaddrinfo 生成结果结构（保证 freeaddrinfo 释放契约一致）
            uint32_t fakeIp = Network::FakeIP::Instance().Alloc(node);
            if (fakeIp != 0) {
                std::string fakeIpStr = Network::FakeIP::IpToString(fakeIp);

                // 兼容仅请求 IPv6 结果的调用方：返回 v4-mapped IPv6，避免 getaddrinfo 因 family 不匹配直接失败
                int family = pHints ? pHints->ai_family : AF_UNSPEC;
                std::string fakeNode = fakeIpStr;
                if (family == AF_INET6) {
                    fakeNode = "::ffff:" + fakeIpStr;
                } else if (family != AF_UNSPEC && family != AF_INET) {
                    // 非预期 family：不改变原始语义，回退原始解析
                    return fpGetAddrInfo(pNodeName, pServiceName, pHints, ppResult);
                }

                int rc = fpGetAddrInfo(fakeNode.c_str(), pServiceName, pHints, ppResult);
                if (rc == 0) {
                    return rc;
                }
                Core::Logger::Warn("FakeIP 回填 getaddrinfo 失败，回退原始解析, family=" + std::to_string(family) +
                                   ", 错误码=" + std::to_string(rc) + ", host=" + node);
                return fpGetAddrInfo(pNodeName, pServiceName, pHints, ppResult);
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
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("拦截到域名解析(W): " + nodeUtf8);
            }
            // 分配虚拟 IP，并让原始 GetAddrInfoW 生成结果结构（保证 FreeAddrInfoW/freeaddrinfo 契约一致）
            uint32_t fakeIp = Network::FakeIP::Instance().Alloc(nodeUtf8);
            if (fakeIp != 0) {
                std::string fakeIpStr = Network::FakeIP::IpToString(fakeIp);

                // 兼容仅请求 IPv6 结果的调用方：返回 v4-mapped IPv6，避免 GetAddrInfoW 因 family 不匹配直接失败
                int family = pHints ? pHints->ai_family : AF_UNSPEC;
                std::string fakeNode = fakeIpStr;
                if (family == AF_INET6) {
                    fakeNode = "::ffff:" + fakeIpStr;
                } else if (family != AF_UNSPEC && family != AF_INET) {
                    // 非预期 family：不改变原始语义，回退原始解析
                    return fpGetAddrInfoW(pNodeName, pServiceName, pHints, ppResult);
                }

                std::wstring fakeNodeW = Utf8ToWide(fakeNode);
                int rc = fpGetAddrInfoW(fakeNodeW.c_str(), pServiceName, pHints, ppResult);
                if (rc == 0) {
                    return rc;
                }
                Core::Logger::Warn("FakeIP 回填 GetAddrInfoW 失败，回退原始解析, family=" + std::to_string(family) +
                                   ", 错误码=" + std::to_string(rc) + ", host=" + nodeUtf8);
                return fpGetAddrInfoW(pNodeName, pServiceName, pHints, ppResult);
            }
            // FakeIP 达到上限时回退原始解析
        }
    }

    return fpGetAddrInfoW(pNodeName, pServiceName, pHints, ppResult);
}

struct hostent* WSAAPI DetourGetHostByName(const char* name) {
    auto& config = Core::Config::Instance();
    if (!fpGetHostByName) return NULL;

    if (name && config.fakeIp.enabled) {
        std::string node = name;
        if (!node.empty() && !IsLoopbackHost(node) && !IsIpLiteralHost(node)) {
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("拦截到域名解析(gethostbyname): " + node);
            }
            uint32_t fakeIp = Network::FakeIP::Instance().Alloc(node);
            if (fakeIp != 0) {
                std::string fakeIpStr = Network::FakeIP::IpToString(fakeIp);
                return fpGetHostByName(fakeIpStr.c_str());
            }
        }
    }
    return fpGetHostByName(name);
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
    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        Core::Logger::Debug(msg + ", sock=" + std::to_string((unsigned long long)s));
    }
    if (!fpWSAConnectByNameA) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    auto& config = Core::Config::Instance();
    if (config.proxy.port != 0 && !node.empty() && !Reserved) {
        sockaddr_storage targetAddr{};
        int targetLen = 0;
        if (ResolveNameToAddr(node, service, config.rules.ipv6_mode, &targetAddr, &targetLen)) {
            // 回填目标地址（如调用方提供缓冲区）
            if (RemoteAddress && RemoteAddressLength && *RemoteAddressLength >= (DWORD)targetLen) {
                memcpy(RemoteAddress, &targetAddr, targetLen);
                *RemoteAddressLength = (DWORD)targetLen;
            }
            int rc = PerformProxyConnect(s, (sockaddr*)&targetAddr, targetLen, true);
            return rc == 0 ? TRUE : FALSE;
        }
        Core::Logger::Warn("WSAConnectByNameA 解析失败，回退原始实现");
    } else if (Reserved) {
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("WSAConnectByNameA 使用 Overlapped，回退原始实现, sock=" + std::to_string((unsigned long long)s));
        }
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
    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        Core::Logger::Debug(msg + ", sock=" + std::to_string((unsigned long long)s));
    }
    if (!fpWSAConnectByNameW) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    auto& config = Core::Config::Instance();
    if (config.proxy.port != 0 && !node.empty() && !Reserved) {
        sockaddr_storage targetAddr{};
        int targetLen = 0;
        if (ResolveNameToAddr(node, service, config.rules.ipv6_mode, &targetAddr, &targetLen)) {
            // 回填目标地址（如调用方提供缓冲区）
            if (RemoteAddress && RemoteAddressLength && *RemoteAddressLength >= (DWORD)targetLen) {
                memcpy(RemoteAddress, &targetAddr, targetLen);
                *RemoteAddressLength = (DWORD)targetLen;
            }
            int rc = PerformProxyConnect(s, (sockaddr*)&targetAddr, targetLen, true);
            return rc == 0 ? TRUE : FALSE;
        }
        Core::Logger::Warn("WSAConnectByNameW 解析失败，回退原始实现");
    } else if (Reserved) {
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("WSAConnectByNameW 使用 Overlapped，回退原始实现, sock=" + std::to_string((unsigned long long)s));
        }
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
            if (connectEx) {
                // ConnectEx 指针可能随 Provider 不同而不同：按 CatalogEntryId 去重安装
                DWORD catalogId = 0;
                const bool hasCatalog = TryGetSocketCatalogEntryId(s, &catalogId);
                void* targetKey = (void*)connectEx;

                std::lock_guard<std::mutex> lock(g_connectExHookMtx);

                // 已安装过该 Provider 的 ConnectEx Hook
                if (hasCatalog) {
                    auto it = g_connectExOriginalByCatalog.find(catalogId);
                    if (it != g_connectExOriginalByCatalog.end() && it->second) {
                        return result;
                    }
                } else if (fpConnectEx) {
                    // 无法获取 Catalog 时，至少保证单 Provider 兜底已存在
                    return result;
                }

                // 如果该 ConnectEx 目标指针已被 Hook，则复用 trampoline 并补全 Catalog 映射（解决多 Provider 环境缺口）
                {
                    auto itTarget = g_connectExTrampolineByTarget.find(targetKey);
                    if (itTarget != g_connectExTrampolineByTarget.end() && itTarget->second) {
                        if (hasCatalog) {
                            g_connectExOriginalByCatalog[catalogId] = itTarget->second;
                        }
                        if (!fpConnectEx) fpConnectEx = itTarget->second;
                        std::string detail = hasCatalog ? (", CatalogEntryId=" + std::to_string(catalogId)) : ", CatalogEntryId=未知";
                        Core::Logger::Info("ConnectEx Hook 已复用" + detail);
                        return result;
                    }
                }

                LPFN_CONNECTEX originalFn = nullptr;
                MH_STATUS st = MH_CreateHook((LPVOID)connectEx, (LPVOID)DetourConnectEx, (LPVOID*)&originalFn);
                if (st == MH_ERROR_ALREADY_CREATED) {
                    // 目标指针已存在 Hook（并发/复用场景），尝试复用已记录 trampoline
                    auto itTarget = g_connectExTrampolineByTarget.find(targetKey);
                    if (itTarget != g_connectExTrampolineByTarget.end() && itTarget->second) {
                        if (hasCatalog) {
                            g_connectExOriginalByCatalog[catalogId] = itTarget->second;
                        }
                        if (!fpConnectEx) fpConnectEx = itTarget->second;
                        std::string detail = hasCatalog ? (", CatalogEntryId=" + std::to_string(catalogId)) : ", CatalogEntryId=未知";
                        Core::Logger::Info("ConnectEx Hook 已复用" + detail);
                    } else {
                        std::string detail = hasCatalog ? (", CatalogEntryId=" + std::to_string(catalogId)) : ", CatalogEntryId=未知";
                        Core::Logger::Warn("ConnectEx Hook 已存在但无法复用 trampoline" + detail);
                    }
                } else if (st != MH_OK) {
                    Core::Logger::Error("Hook ConnectEx 失败");
                } else if (MH_EnableHook((LPVOID)connectEx) != MH_OK) {
                    Core::Logger::Error("启用 ConnectEx Hook 失败");
                } else {
                    g_connectExTrampolineByTarget[targetKey] = originalFn;
                    if (hasCatalog) {
                        g_connectExOriginalByCatalog[catalogId] = originalFn;
                    }
                    // 保留一个兜底 trampoline，兼容无法获取 Catalog 的极端场景
                    if (!fpConnectEx) fpConnectEx = originalFn;
                    std::string detail;
                    if (hasCatalog) {
                        detail += ", CatalogEntryId=" + std::to_string(catalogId);
                    } else {
                        detail += ", CatalogEntryId=未知";
                    }
                    Core::Logger::Info("ConnectEx Hook 已安装" + detail);
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
    // ConnectEx trampoline 可能因 Provider 不同而不同，这里按 socket Provider 选择对应的原始实现
    LPFN_CONNECTEX originalConnectEx = GetOriginalConnectExForSocket(s);
    if (!originalConnectEx) {
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
    if (name->sa_family == AF_INET6 && namelen < (int)sizeof(sockaddr_in6)) {
        WSASetLastError(WSAEINVAL);
        return FALSE;
    }
    
    // Hook 调用日志：仅在 Debug 下记录参数，避免热路径字符串拼接开销
    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        const std::string dst = SockaddrToString(name);
        Core::Logger::Debug("ConnectEx: 调用, sock=" + std::to_string((unsigned long long)s) +
                            ", dst=" + (dst.empty() ? "(未知)" : dst) +
                            ", send_len=" + std::to_string((unsigned long long)dwSendDataLength) +
                            ", overlapped=" + std::to_string((unsigned long long)(ULONG_PTR)lpOverlapped));
    }

    auto& config = Core::Config::Instance();
    LogRuntimeConfigSummaryOnce();
    Network::SocketWrapper sock(s);
    sock.SetTimeouts(config.timeout.recv_ms, config.timeout.send_ms);
    
    // 仅对 TCP (SOCK_STREAM) 做代理，避免误伤 UDP/QUIC 等
    if (config.proxy.port != 0 && !IsStreamSocket(s)) {
        int soType = 0;
        TryGetSocketType(s, &soType);

        // UDP 强阻断：默认阻断 UDP（除 DNS/loopback 例外），强制应用回退到 TCP 再走代理
        // 说明：ConnectEx 理论上主要用于 TCP，但部分运行库可能复用接口，这里保持策略一致。
        if (soType == SOCK_DGRAM && config.rules.udp_mode == "block") {
            uint16_t dstPort = 0;
            const bool hasPort = TryGetSockaddrPort(name, &dstPort);
            const bool allowUdp = IsSockaddrLoopback(name) || (hasPort && dstPort == 53);
            if (!allowUdp) {
                const int err = WSAENETUNREACH;
                if (ShouldLogUdpBlock()) {
                    const std::string dst = SockaddrToString(name);
                    Core::Logger::Warn("ConnectEx: 已阻止 UDP 连接(策略: udp_mode=block, 说明: 禁用 QUIC/HTTP3), sock=" + std::to_string((unsigned long long)s) +
                                       (dst.empty() ? "" : ", dst=" + dst) +
                                       (hasPort ? (", port=" + std::to_string(dstPort)) : std::string("")) +
                                       ", WSA错误码=" + std::to_string(err));
                }
                WSASetLastError(err);
                return FALSE;
            }
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                const std::string dst = SockaddrToString(name);
                Core::Logger::Debug("ConnectEx: UDP 直连已放行(例外), sock=" + std::to_string((unsigned long long)s) +
                                    (dst.empty() ? "" : ", dst=" + dst));
            }
            return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
        }

        // 其他非 SOCK_STREAM 类型保持直连；仅在 Debug 下记录，避免刷屏影响性能
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            const std::string dst = SockaddrToString(name);
            Core::Logger::Debug("ConnectEx: 非 SOCK_STREAM 直连, sock=" + std::to_string((unsigned long long)s) +
                                ", soType=" + std::to_string(soType) +
                                (dst.empty() ? "" : ", dst=" + dst));
        }
        return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }

    if (name->sa_family == AF_INET6) {
        const auto* addr6 = (const sockaddr_in6*)name;
        const bool isV4Mapped = IN6_IS_ADDR_V4MAPPED(&addr6->sin6_addr);

        // v4-mapped IPv6 本质是 IPv4 连接：不应被 ipv6_mode 误伤（否则会影响 FakeIP v4-mapped 回填）
        if (!isV4Mapped) {
            std::string addrStr = SockaddrToString(name);
            if (config.proxy.port != 0) {
                const std::string& ipv6Mode = config.rules.ipv6_mode;
                if (ipv6Mode == "direct") {
                    Core::Logger::Info("ConnectEx IPv6 连接已直连(策略: direct), sock=" + std::to_string((unsigned long long)s) +
                                       ", family=" + std::to_string((int)name->sa_family) +
                                       (addrStr.empty() ? "" : ", addr=" + addrStr));
                    return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
                }
                if (ipv6Mode != "proxy") {
                    // 强制阻止 IPv6，避免绕过代理
                    Core::Logger::Warn("ConnectEx 已阻止 IPv6 连接(策略: block), sock=" + std::to_string((unsigned long long)s) +
                                       ", family=" + std::to_string((int)name->sa_family) +
                                       (addrStr.empty() ? "" : ", addr=" + addrStr));
                    WSASetLastError(WSAEAFNOSUPPORT);
                    return FALSE;
                }
            } else {
                Core::Logger::Info("ConnectEx IPv6 连接已直连, sock=" + std::to_string((unsigned long long)s) +
                                   ", family=" + std::to_string((int)name->sa_family) +
                                   (addrStr.empty() ? "" : ", addr=" + addrStr));
                return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
            }
        }
    } else if (name->sa_family != AF_INET) {
        std::string addrStr = SockaddrToString(name);
        if (config.proxy.port != 0) {
            // 非 IPv4/IPv6 连接一律阻止，避免绕过代理
            Core::Logger::Warn("ConnectEx 已阻止非 IPv4/IPv6 连接, sock=" + std::to_string((unsigned long long)s) +
                               ", family=" + std::to_string((int)name->sa_family) +
                               (addrStr.empty() ? "" : ", addr=" + addrStr));
            WSASetLastError(WSAEAFNOSUPPORT);
            return FALSE;
        }
        Core::Logger::Info("ConnectEx 非 IPv4/IPv6 连接已直连, sock=" + std::to_string((unsigned long long)s) +
                           ", family=" + std::to_string((int)name->sa_family) +
                           (addrStr.empty() ? "" : ", addr=" + addrStr));
        return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    std::string originalHost;
    uint16_t originalPort = 0;
    if (!ResolveOriginalTarget(name, &originalHost, &originalPort)) {
        return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    if (IsLoopbackHost(originalHost)) {
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("ConnectEx BYPASS(loopback): sock=" + std::to_string((unsigned long long)s) +
                                ", target=" + originalHost + ":" + std::to_string(originalPort));
        }
        return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    if (IsProxySelfTarget(originalHost, originalPort, config.proxy)) {
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("ConnectEx BYPASS(proxy-self): sock=" + std::to_string((unsigned long long)s) +
                                ", target=" + originalHost + ":" + std::to_string(originalPort) +
                                ", proxy=" + config.proxy.host + ":" + std::to_string(config.proxy.port));
        }
        return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    if (config.proxy.port == 0) {
        return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }

    // ============= 智能路由决策（与 PerformProxyConnect 保持一致） =============
    // ROUTE-1: DNS 端口特殊处理 (解决 DNS 超时问题)
    if (originalPort == 53) {
        if (config.rules.dns_mode == "direct" || config.rules.dns_mode.empty()) {
            Core::Logger::Info("ConnectEx DNS 请求直连 (策略: direct), sock=" + std::to_string((unsigned long long)s) +
                               ", 目标: " + originalHost + ":53");
            return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
        }
        // dns_mode == "proxy" 则继续走后面的代理逻辑
        Core::Logger::Info("ConnectEx DNS 请求走代理 (策略: proxy), sock=" + std::to_string((unsigned long long)s) +
                           ", 目标: " + originalHost + ":53");
    }

    // ROUTE-2: 端口白名单过滤
    if (!config.rules.IsPortAllowed(originalPort)) {
        Core::Logger::Info("ConnectEx 端口 " + std::to_string(originalPort) + " 不在白名单, sock=" + std::to_string((unsigned long long)s) +
                           ", 直连: " + originalHost);
        return originalConnectEx(s, name, namelen, lpSendBuffer, dwSendDataLength, lpdwBytesSent, lpOverlapped);
    }
    
    Core::Logger::Info("ConnectEx 正重定向 " + originalHost + ":" + std::to_string(originalPort) +
                       " 到代理, sock=" + std::to_string((unsigned long long)s));
    
    DWORD ignoredBytes = 0;
    BOOL result = FALSE;
    if (name->sa_family == AF_INET6) {
        sockaddr_in6 proxyAddr6{};
        if (!BuildProxyAddrV6(config.proxy, &proxyAddr6, (sockaddr_in6*)name)) {
            WSASetLastError(WSAEINVAL);
            return FALSE;
        }
        result = originalConnectEx(s, (sockaddr*)&proxyAddr6, sizeof(proxyAddr6), NULL, 0,
                                  lpdwBytesSent ? lpdwBytesSent : &ignoredBytes, lpOverlapped);
    } else {
        sockaddr_in proxyAddr{};
        if (!BuildProxyAddr(config.proxy, &proxyAddr, (sockaddr_in*)name)) {
            WSASetLastError(WSAEINVAL);
            return FALSE;
        }
        result = originalConnectEx(s, (sockaddr*)&proxyAddr, sizeof(proxyAddr), NULL, 0,
                                  lpdwBytesSent ? lpdwBytesSent : &ignoredBytes, lpOverlapped);
    }
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
                Core::Logger::Info("ConnectEx 返回 WSA_IO_PENDING 但未提供 Overlapped, sock=" + std::to_string((unsigned long long)s) +
                                   ", 目标=" + originalHost + ":" + std::to_string(originalPort));
            }
            return FALSE;
        }
        Core::Logger::Error("ConnectEx 连接代理服务器失败, sock=" + std::to_string((unsigned long long)s) +
                            ", WSA错误码=" + std::to_string(err));
        WSASetLastError(err);
        return FALSE;
    }
    
    if (!UpdateConnectExContext(s)) {
        return FALSE;
    }
    if (!DoProxyHandshake(s, originalHost, originalPort)) {
        return FALSE;
    }
    
    if (lpSendBuffer && dwSendDataLength > 0) {
        // 使用统一 SendAll，兼容非阻塞 socket / partial send
        if (!Network::SocketIo::SendAll(s, (const char*)lpSendBuffer, (int)dwSendDataLength, config.timeout.send_ms)) {
            int err = WSAGetLastError();
            Core::Logger::Error("ConnectEx 发送首包失败, sock=" + std::to_string((unsigned long long)s) +
                                ", bytes=" + std::to_string((unsigned long long)dwSendDataLength) +
                                ", WSA错误码=" + std::to_string(err));
            WSASetLastError(err);
            return FALSE;
        }
        if (lpdwBytesSent) {
            *lpdwBytesSent = dwSendDataLength;
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
        DWORD sentBytes = 0;
        if (!HandleConnectExCompletion(lpOverlapped, &sentBytes)) {
            if (WSAGetLastError() == 0) WSASetLastError(WSAECONNREFUSED);
            return FALSE;
        }
        // ConnectEx 带首包时，原始返回的 lpcbTransfer 可能为 0，这里回填为实际发送字节数
        if (sentBytes > 0 && lpcbTransfer) {
            *lpcbTransfer = sentBytes;
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
        // FIX-1: 单事件版本 - result=TRUE 表示 IOCP 操作成功
        DWORD sentBytes = 0;
        if (!HandleConnectExCompletion(*lpOverlapped, &sentBytes)) {
            // 握手失败：记录日志，但不返回 FALSE（DoProxyHandshake 内部会设置合适的错误码）
            Core::Logger::Error("GetQueuedCompletionStatus: ConnectEx 握手失败");
            // FIX-1: 不再返回 FALSE，让调用方根据后续 I/O 判断连接状态
        }
        if (sentBytes > 0 && lpNumberOfBytes) {
            *lpNumberOfBytes = sentBytes;
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
        // FIX-1: 遍历所有完成的事件，检查 IOCP 完成状态后再处理
        for (ULONG i = 0; i < *ulNumEntriesRemoved; i++) {
            LPOVERLAPPED ovl = lpCompletionPortEntries[i].lpOverlapped;
            if (!ovl) continue;
            
            // FIX-1: 检查 IOCP 完成状态（Internal 字段存储 NTSTATUS，本质是 LONG）
            // STATUS_SUCCESS = 0，非零表示操作失败（如连接被拒绝、超时等）
            // 注意：Internal 字段在 OVERLAPPED_ENTRY 中类型为 ULONG_PTR
            LONG ioStatus = (LONG)lpCompletionPortEntries[i].Internal;
            if (ioStatus != 0) {
                // 连接失败：清理上下文，继续处理下一个事件（不阻断整个批次）
                if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                    Core::Logger::Debug("GetQueuedCompletionStatusEx: IOCP 事件失败, status=" + 
                                        std::to_string(ioStatus) + ", 跳过握手");
                }
                DropConnectExContext(ovl);
                continue;
            }
            
            // 连接成功：尝试处理 ConnectEx 完成握手
            // 如果不是我们跟踪的 Overlapped，HandleConnectExCompletion 会直接返回 true
            DWORD sentBytes = 0;
            if (!HandleConnectExCompletion(ovl, &sentBytes)) {
                // 握手失败：记录日志，但不返回 FALSE（避免影响其他连接）
                Core::Logger::Error("GetQueuedCompletionStatusEx: ConnectEx 握手失败");
                // FIX-1: 继续处理下一个事件，不阻断整个批次
            }
            if (sentBytes > 0) {
                // 回填 ConnectEx 首包发送字节数，提升与标准 ConnectEx 语义的一致性
                lpCompletionPortEntries[i].dwNumberOfBytesTransferred = sentBytes;
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
                const bool injected = Injection::ProcessInjector::InjectDll(lpProcessInformation->hProcess, dllPath);
                if (injected) {
                    Core::Logger::Info("[成功] 已注入目标进程: " + appName + " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ") - 父子关系建立");
                } else {
                    Core::Logger::Error("[失败] 注入目标进程失败: " + appName + " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ")");
                }
            } else {
                Core::Logger::Error("[失败] 获取当前 DLL 路径失败，跳过注入: " + appName + " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ")");
            }
            
            // 如果原始调用没有要求挂起，则恢复进程
            if (!(dwCreationFlags & CREATE_SUSPENDED)) {
                ResumeThread(lpProcessInformation->hThread);
            }
        }
    }
    
    return result;
}

BOOL WINAPI DetourCreateProcessA(
    LPCSTR lpApplicationName,
    LPSTR lpCommandLine,
    LPSECURITY_ATTRIBUTES lpProcessAttributes,
    LPSECURITY_ATTRIBUTES lpThreadAttributes,
    BOOL bInheritHandles,
    DWORD dwCreationFlags,
    LPVOID lpEnvironment,
    LPCSTR lpCurrentDirectory,
    LPSTARTUPINFOA lpStartupInfo,
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
    if (!fpCreateProcessA) {
        SetLastError(ERROR_PROC_NOT_FOUND);
        return FALSE;
    }
    BOOL result = fpCreateProcessA(
        lpApplicationName, lpCommandLine,
        lpProcessAttributes, lpThreadAttributes,
        bInheritHandles, modifiedFlags,
        lpEnvironment, lpCurrentDirectory,
        lpStartupInfo, lpProcessInformation
    );
    
    if (result && needInject && lpProcessInformation) {
        // 先提取进程名用于过滤检查
        std::string appName = "Unknown";
        const char* targetStr = lpApplicationName ? lpApplicationName : lpCommandLine;
        if (targetStr) {
            appName = targetStr;
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
            Core::Logger::Info("拦截到进程创建(CreateProcessA)，准备注入 DLL...");
            
            // 注入 DLL 到子进程
            std::wstring dllPath = Injection::ProcessInjector::GetCurrentDllPath();
            if (!dllPath.empty()) {
                const bool injected = Injection::ProcessInjector::InjectDll(lpProcessInformation->hProcess, dllPath);
                if (injected) {
                    Core::Logger::Info("[成功] 已注入目标进程: " + appName + " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ") - 父子关系建立");
                } else {
                    Core::Logger::Error("[失败] 注入目标进程失败: " + appName + " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ")");
                }
            } else {
                Core::Logger::Error("[失败] 获取当前 DLL 路径失败，跳过注入: " + appName + " (PID: " + std::to_string(lpProcessInformation->dwProcessId) + ")");
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

// ============= UDP 强阻断: sendto / WSASendTo Hook =============

int WSAAPI DetourSendTo(SOCKET s, const char* buf, int len, int flags, const struct sockaddr* to, int tolen) {
    if (!fpSendTo) {
        WSASetLastError(WSAEINVAL);
        return SOCKET_ERROR;
    }

    auto& config = Core::Config::Instance();
    if (config.proxy.port != 0 && config.rules.udp_mode == "block") {
        int soType = 0;
        if (TryGetSocketType(s, &soType) && soType == SOCK_DGRAM) {
            sockaddr_storage peer{};
            int peerLen = (int)sizeof(peer);
            const sockaddr* dst = to;
            if (!dst) {
                if (getpeername(s, (sockaddr*)&peer, &peerLen) == 0) {
                    dst = (sockaddr*)&peer;
                }
            }

            uint16_t dstPort = 0;
            const bool hasPort = TryGetSockaddrPort(dst, &dstPort);
            const bool allowUdp = dst && (IsSockaddrLoopback(dst) || (hasPort && dstPort == 53));
            if (!allowUdp) {
                const int err = WSAENETUNREACH;
                if (ShouldLogUdpBlock()) {
                    const std::string dstStr = dst ? SockaddrToString(dst) : std::string("(未知)");
                    Core::Logger::Warn("sendto: 已阻止 UDP 发送(策略: udp_mode=block, 说明: 禁用 QUIC/HTTP3), sock=" + std::to_string((unsigned long long)s) +
                                       ", dst=" + dstStr +
                                       (hasPort ? (", port=" + std::to_string(dstPort)) : std::string("")) +
                                       ", WSA错误码=" + std::to_string(err));
                }
                WSASetLastError(err);
                return SOCKET_ERROR;
            }
        }
    }

    return fpSendTo(s, buf, len, flags, to, tolen);
}

int WSAAPI DetourWSASendTo(
    SOCKET s, LPWSABUF lpBuffers, DWORD dwBufferCount,
    LPDWORD lpNumberOfBytesSent, DWORD dwFlags,
    const struct sockaddr* lpTo, int iToLen,
    LPWSAOVERLAPPED lpOverlapped,
    LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine
) {
    if (!fpWSASendTo) {
        WSASetLastError(WSAEINVAL);
        return SOCKET_ERROR;
    }

    auto& config = Core::Config::Instance();
    if (config.proxy.port != 0 && config.rules.udp_mode == "block") {
        int soType = 0;
        if (TryGetSocketType(s, &soType) && soType == SOCK_DGRAM) {
            sockaddr_storage peer{};
            int peerLen = (int)sizeof(peer);
            const sockaddr* dst = lpTo;
            if (!dst) {
                if (getpeername(s, (sockaddr*)&peer, &peerLen) == 0) {
                    dst = (sockaddr*)&peer;
                }
            }

            uint16_t dstPort = 0;
            const bool hasPort = TryGetSockaddrPort(dst, &dstPort);
            const bool allowUdp = dst && (IsSockaddrLoopback(dst) || (hasPort && dstPort == 53));
            if (!allowUdp) {
                const int err = WSAENETUNREACH;
                if (lpNumberOfBytesSent) {
                    *lpNumberOfBytesSent = 0;
                }
                if (ShouldLogUdpBlock()) {
                    const std::string dstStr = dst ? SockaddrToString(dst) : std::string("(未知)");
                    Core::Logger::Warn("WSASendTo: 已阻止 UDP 发送(策略: udp_mode=block, 说明: 禁用 QUIC/HTTP3), sock=" + std::to_string((unsigned long long)s) +
                                       ", dst=" + dstStr +
                                       (hasPort ? (", port=" + std::to_string(dstPort)) : std::string("")) +
                                       ", WSA错误码=" + std::to_string(err));
                }
                WSASetLastError(err);
                return SOCKET_ERROR;
            }
        }
    }

    return fpWSASendTo(s, lpBuffers, dwBufferCount, lpNumberOfBytesSent, dwFlags, lpTo, iToLen, lpOverlapped, lpCompletionRoutine);
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

        // Hook closesocket / shutdown（记录连接断开过程）
        if (MH_CreateHookApi(L"ws2_32.dll", "closesocket",
                             (LPVOID)DetourCloseSocket, (LPVOID*)&fpCloseSocket) != MH_OK) {
            Core::Logger::Error("Hook closesocket 失败");
        }
        if (MH_CreateHookApi(L"ws2_32.dll", "shutdown",
                             (LPVOID)DetourShutdown, (LPVOID*)&fpShutdown) != MH_OK) {
            Core::Logger::Error("Hook shutdown 失败");
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
        
        // Hook gethostbyname
        if (MH_CreateHookApi(L"ws2_32.dll", "gethostbyname", 
                             (LPVOID)DetourGetHostByName, (LPVOID*)&fpGetHostByName) != MH_OK) {
            Core::Logger::Error("Hook gethostbyname 失败");
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

        // Hook CreateProcessA（补齐 ANSI 路径，降低子进程漏注入概率）
        if (MH_CreateHookApi(L"kernel32.dll", "CreateProcessA",
                             (LPVOID)DetourCreateProcessA, (LPVOID*)&fpCreateProcessA) != MH_OK) {
            Core::Logger::Error("Hook CreateProcessA 失败");
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

        // Hook sendto / WSASendTo（UDP 强阻断：阻止 QUIC/HTTP3 等绕过代理）
        if (MH_CreateHookApi(L"ws2_32.dll", "sendto",
                             (LPVOID)DetourSendTo, (LPVOID*)&fpSendTo) != MH_OK) {
            Core::Logger::Error("Hook sendto 失败");
        }
        if (MH_CreateHookApi(L"ws2_32.dll", "WSASendTo",
                             (LPVOID)DetourWSASendTo, (LPVOID*)&fpWSASendTo) != MH_OK) {
            Core::Logger::Error("Hook WSASendTo 失败");
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
        {
            // 清理 socket -> 原始目标映射，避免卸载后残留
            std::lock_guard<std::mutex> lock(g_socketTargetsMtx);
            g_socketTargets.clear();
        }
        {
            // 清理 ConnectEx Provider trampoline 映射，避免卸载后残留
            std::lock_guard<std::mutex> lock(g_connectExHookMtx);
            g_connectExOriginalByCatalog.clear();
            g_connectExTrampolineByTarget.clear();
            fpConnectEx = NULL;
        }
        MH_DisableHook(MH_ALL_HOOKS);
        MH_Uninitialize();
    }
}
