#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>
#include <chrono>
#include <limits>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include "../core/Config.hpp"
#include "../core/Logger.hpp"
#include "SocketIo.hpp"

namespace Network {
    
    // SOCKS5 Protocol Constants
    namespace Socks5 {
        constexpr uint8_t VERSION = 0x05;
        constexpr uint8_t AUTH_NONE = 0x00;
        constexpr uint8_t CMD_CONNECT = 0x01;
        constexpr uint8_t CMD_UDP_ASSOCIATE = 0x03;
        constexpr uint8_t ATYP_IPV4 = 0x01;
        constexpr uint8_t ATYP_DOMAIN = 0x03;
        constexpr uint8_t ATYP_IPV6 = 0x04;
        constexpr uint8_t REPLY_SUCCESS = 0x00;
    }
    
    class Socks5Client {
    private:
        using SteadyClock = std::chrono::steady_clock;

        static int NormalizeTimeoutMs(int timeoutMs) {
            return timeoutMs > 0 ? timeoutMs : 5000;
        }

        static SteadyClock::time_point BuildDeadline(int timeoutMs) {
            return SteadyClock::now() + std::chrono::milliseconds(NormalizeTimeoutMs(timeoutMs));
        }

        static int RemainingTimeoutMs(const SteadyClock::time_point& deadline, int fallbackMs) {
            const int fallback = NormalizeTimeoutMs(fallbackMs);
            const auto now = SteadyClock::now();
            if (now >= deadline) {
                WSASetLastError(WSAETIMEDOUT);
                return 0;
            }
            const auto remainMs = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
            if (remainMs <= 0) {
                WSASetLastError(WSAETIMEDOUT);
                return 0;
            }
            if (remainMs > (std::numeric_limits<int>::max)()) {
                return fallback;
            }
            const int remain = static_cast<int>(remainMs);
            return remain < fallback ? remain : fallback;
        }

        // 失败时输出少量字节摘要（避免刷屏/泄露敏感信息）
        static std::string HexDump(const uint8_t* data, size_t len, size_t maxBytes) {
            if (!data || len == 0 || maxBytes == 0) return "";
            const size_t n = (len < maxBytes) ? len : maxBytes;
            std::ostringstream oss;
            oss << std::hex << std::uppercase << std::setfill('0');
            for (size_t i = 0; i < n; ++i) {
                if (i) oss << ' ';
                oss << std::setw(2) << static_cast<int>(data[i]);
            }
            if (len > maxBytes) oss << " ...";
            return oss.str();
        }

        static const char* ReplyToText(uint8_t rep) {
            switch (rep) {
                case 0x00: return "成功";
                case 0x01: return "通用失败";
                case 0x02: return "连接不允许(规则集)";
                case 0x03: return "网络不可达";
                case 0x04: return "主机不可达";
                case 0x05: return "连接被拒绝";
                case 0x06: return "TTL 已过期";
                case 0x07: return "不支持的命令";
                case 0x08: return "不支持的地址类型";
                default:   return "未知";
            }
        }

        // Helper to ensure exact number of bytes are read (handles TCP fragmentation)
        static bool ReadExact(SOCKET sock, uint8_t* buf, int len, int timeoutMs) {
            // 使用统一的 IO 封装，兼容非阻塞套接字
            return SocketIo::RecvExact(sock, buf, len, timeoutMs);
        }

    public:
        // Execute SOCKS5 Handshake (No Auth)
        // Returns true if tunnel is established
        static bool Handshake(SOCKET sock, const std::string& targetHost, uint16_t targetPort, int handshakeBudgetMs = -1) {
            auto& config = Core::Config::Instance();
            const int recvTimeout = NormalizeTimeoutMs(config.timeout.recv_ms);
            const int sendTimeout = NormalizeTimeoutMs(config.timeout.send_ms);
            if (handshakeBudgetMs <= 0) {
                handshakeBudgetMs = config.timeout.connect_ms + sendTimeout + recvTimeout;
            }
            if (handshakeBudgetMs <= 0) {
                handshakeBudgetMs = sendTimeout + recvTimeout;
            }
            const auto deadline = BuildDeadline(handshakeBudgetMs);

            auto stepTimeout = [&](int fallbackMs, const char* stage) -> int {
                const int timeoutMs = RemainingTimeoutMs(deadline, fallbackMs);
                if (timeoutMs <= 0) {
                    Core::Logger::Error(std::string("SOCKS5: ") + stage + " 握手预算耗尽, sock=" +
                                        std::to_string((unsigned long long)sock));
                }
                return timeoutMs;
            };

            if (targetHost.empty()) {
                Core::Logger::Error("SOCKS5: 目标主机为空, sock=" + std::to_string((unsigned long long)sock));
                WSASetLastError(WSAEINVAL);
                return false;
            }

            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("SOCKS5: 开始握手, sock=" + std::to_string((unsigned long long)sock) +
                                    ", 目标=" + targetHost + ":" + std::to_string(targetPort) +
                                    ", 预算=" + std::to_string(handshakeBudgetMs) + "ms");
            }

            // 1. Auth Method Negotiation
            // +----+----------+----------+
            // |VER | NMETHODS | METHODS  |
            // +----+----------+----------+
            // | 1  |    1     | 1 to 255 |
            // +----+----------+----------+
            uint8_t authRequest[3] = { Socks5::VERSION, 0x01, Socks5::AUTH_NONE };
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("SOCKS5: [1/3] 发送认证协商, sock=" + std::to_string((unsigned long long)sock) +
                                    ", bytes=" + HexDump(authRequest, 3, 16));
            }
            const int authReqTimeout = stepTimeout(sendTimeout, "[1/3] 发送认证协商");
            if (authReqTimeout <= 0) return false;
            if (!SocketIo::SendAll(sock, (const char*)authRequest, 3, authReqTimeout)) {
                int err = WSAGetLastError();
                Core::Logger::Error("SOCKS5: [1/3] 发送认证协商失败, sock=" + std::to_string((unsigned long long)sock) +
                                    ", WSA错误码=" + std::to_string(err));
                return false;
            }
            
            // Receive Auth Method Response
            uint8_t authResponse[2];
            const int authRespTimeout = stepTimeout(recvTimeout, "[1/3] 读取认证响应");
            if (authRespTimeout <= 0) return false;
            if (!ReadExact(sock, authResponse, 2, authRespTimeout)) {
                int err = WSAGetLastError();
                Core::Logger::Error("SOCKS5: [1/3] 读取认证响应失败, sock=" + std::to_string((unsigned long long)sock) +
                                    ", WSA错误码=" + std::to_string(err));
                return false;
            }
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("SOCKS5: [1/3] 收到认证响应, sock=" + std::to_string((unsigned long long)sock) +
                                    ", VER=" + std::to_string(authResponse[0]) + ", METHOD=" + std::to_string(authResponse[1]) +
                                    ", bytes=" + HexDump(authResponse, 2, 16));
            }
            
            if (authResponse[0] != Socks5::VERSION || authResponse[1] != Socks5::AUTH_NONE) {
                Core::Logger::Error("SOCKS5: [1/3] 不支持的认证方式, sock=" + std::to_string((unsigned long long)sock) +
                                    ", 版本=" + std::to_string(authResponse[0]) + ", 方法=" + std::to_string(authResponse[1]) +
                                    ", bytes=" + HexDump(authResponse, 2, 16));
                return false;
            }
            
            // 2. Send Connect Request
            // +----+-----+-------+------+----------+----------+
            // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
            // +----+-----+-------+------+----------+----------+
            std::vector<uint8_t> request;
            request.push_back(Socks5::VERSION);
            request.push_back(Socks5::CMD_CONNECT);
            request.push_back(0x00); // RSV
            
            uint8_t atypForLog = Socks5::ATYP_DOMAIN;
            in_addr addr{};
            if (inet_pton(AF_INET, targetHost.c_str(), &addr) == 1) {
                // IPv4 地址
                atypForLog = Socks5::ATYP_IPV4;
                request.push_back(atypForLog);
                request.push_back((addr.s_addr >> 0) & 0xFF);
                request.push_back((addr.s_addr >> 8) & 0xFF);
                request.push_back((addr.s_addr >> 16) & 0xFF);
                request.push_back((addr.s_addr >> 24) & 0xFF);
            } else {
                in6_addr addr6{};
                if (inet_pton(AF_INET6, targetHost.c_str(), &addr6) == 1) {
                    // IPv6 地址
                    atypForLog = Socks5::ATYP_IPV6;
                    request.push_back(atypForLog);
                    const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&addr6);
                    for (int i = 0; i < 16; ++i) request.push_back(bytes[i]);
                } else {
                    // 域名
                    if (targetHost.size() > 255) {
                        Core::Logger::Error("SOCKS5: [2/3] 目标域名过长, sock=" + std::to_string((unsigned long long)sock) +
                                            ", len=" + std::to_string(targetHost.size()));
                        WSASetLastError(WSAEINVAL);
                        return false;
                    }
                    atypForLog = Socks5::ATYP_DOMAIN;
                    request.push_back(atypForLog);
                    uint8_t len = static_cast<uint8_t>(targetHost.length());
                    request.push_back(len);
                    for (char c : targetHost) request.push_back(c);
                }
            }
            
            // Port (Network Byte Order)
            request.push_back((targetPort >> 8) & 0xFF);
            request.push_back(targetPort & 0xFF);
            
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("SOCKS5: [2/3] 发送 CONNECT 请求, sock=" + std::to_string((unsigned long long)sock) +
                                    ", ATYP=" + std::to_string(atypForLog) +
                                    ", payload_len=" + std::to_string(request.size()));
            }
            const int connectReqTimeout = stepTimeout(sendTimeout, "[2/3] 发送 CONNECT 请求");
            if (connectReqTimeout <= 0) return false;
            if (!SocketIo::SendAll(sock, (const char*)request.data(), (int)request.size(), connectReqTimeout)) {
                int err = WSAGetLastError();
                Core::Logger::Error("SOCKS5: [2/3] 发送 CONNECT 请求失败, sock=" + std::to_string((unsigned long long)sock) +
                                    ", WSA错误码=" + std::to_string(err));
                return false;
            }
            
            // 3. Receive Connect Response
            // We need to handle variable length responses carefully
            
            // Read Header: VER, REP, RSV, ATYP
            uint8_t header[4];
            const int respHeaderTimeout = stepTimeout(recvTimeout, "[3/3] 读取响应头");
            if (respHeaderTimeout <= 0) return false;
            if (!ReadExact(sock, header, 4, respHeaderTimeout)) {
                int err = WSAGetLastError();
                Core::Logger::Error("SOCKS5: [3/3] 读取响应头失败, sock=" + std::to_string((unsigned long long)sock) +
                                    ", WSA错误码=" + std::to_string(err));
                return false;
            }
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("SOCKS5: [3/3] 收到响应头, sock=" + std::to_string((unsigned long long)sock) +
                                    ", VER=" + std::to_string(header[0]) + ", REP=" + std::to_string(header[1]) +
                                    ", ATYP=" + std::to_string(header[3]) + ", bytes=" + HexDump(header, 4, 16));
            }
            
            if (header[0] != Socks5::VERSION) {
                Core::Logger::Error("SOCKS5: [3/3] 响应版本无效, sock=" + std::to_string((unsigned long long)sock) +
                                    ", VER=" + std::to_string(header[0]) + ", bytes=" + HexDump(header, 4, 16));
                return false;
            }
            
            if (header[1] != Socks5::REPLY_SUCCESS) {
                Core::Logger::Error("SOCKS5: [3/3] 代理服务器拒绝 CONNECT, sock=" + std::to_string((unsigned long long)sock) +
                                    ", REP=" + std::to_string(header[1]) + "(" + ReplyToText(header[1]) + ")" +
                                    ", 目标=" + targetHost + ":" + std::to_string(targetPort) +
                                    ", bytes=" + HexDump(header, 4, 16));
                return false;
            }
            
            // Determine Address Length based on ATYP
            uint8_t atyp = header[3];
            int addrLen = 0;
            switch(atyp) {
                case Socks5::ATYP_IPV4: 
                    addrLen = 4; 
                    break;
                case Socks5::ATYP_IPV6: 
                    addrLen = 16; 
                    break;
                case Socks5::ATYP_DOMAIN: {
                    uint8_t lenByte;
                    const int domainLenTimeout = stepTimeout(recvTimeout, "[3/3] 读取 BND.DOMAIN 长度");
                    if (domainLenTimeout <= 0) return false;
                    if (!ReadExact(sock, &lenByte, 1, domainLenTimeout)) {
                        int err = WSAGetLastError();
                        Core::Logger::Error("SOCKS5: [3/3] 读取 BND.DOMAIN 长度失败, sock=" + std::to_string((unsigned long long)sock) +
                                            ", WSA错误码=" + std::to_string(err));
                        return false;
                    }
                    addrLen = lenByte;
                    break;
                }
                default:
                    Core::Logger::Error("SOCKS5: [3/3] 未知的 ATYP, sock=" + std::to_string((unsigned long long)sock) +
                                        ", ATYP=" + std::to_string(atyp) + ", bytes=" + HexDump(header, 4, 16));
                    return false;
            }
            
            // Consume Address Bytes (Ignore actual value as we don't need the bind addr)
            if (addrLen > 0) {
                std::vector<uint8_t> trash(addrLen);
                const int bndAddrTimeout = stepTimeout(recvTimeout, "[3/3] 读取 BND.ADDR");
                if (bndAddrTimeout <= 0) return false;
                if (!ReadExact(sock, trash.data(), addrLen, bndAddrTimeout)) {
                    int err = WSAGetLastError();
                    Core::Logger::Error("SOCKS5: [3/3] 读取 BND.ADDR 失败, sock=" + std::to_string((unsigned long long)sock) +
                                        ", WSA错误码=" + std::to_string(err));
                    return false;
                }
            }
            
            // Consume Port (2 bytes)
            uint8_t portBuf[2];
            const int bndPortTimeout = stepTimeout(recvTimeout, "[3/3] 读取 BND.PORT");
            if (bndPortTimeout <= 0) return false;
            if (!ReadExact(sock, portBuf, 2, bndPortTimeout)) {
                int err = WSAGetLastError();
                Core::Logger::Error("SOCKS5: [3/3] 读取 BND.PORT 失败, sock=" + std::to_string((unsigned long long)sock) +
                                    ", WSA错误码=" + std::to_string(err));
                return false;
            }
            
            Core::Logger::Info("SOCKS5: 隧道建立成功, sock=" + std::to_string((unsigned long long)sock) +
                               ", 目标=" + targetHost + ":" + std::to_string(targetPort) +
                               ", BND.ATYP=" + std::to_string(atyp) +
                               ", BND.PORT=" + std::to_string((static_cast<uint16_t>(portBuf[0]) << 8) | portBuf[1]));
            return true;
        }
    };
}
