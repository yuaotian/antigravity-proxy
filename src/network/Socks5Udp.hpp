#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>
#include <cstdint>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <cstring>
#include "../core/Config.hpp"
#include "../core/Logger.hpp"
#include "SocketIo.hpp"
#include "Socks5.hpp"

namespace Network {

    // SOCKS5 UDP Associate + UDP 报文封装/解封装
    // 设计目标：
    // - 为 Hooks 层提供“透明 UDP/QUIC 代理”的基础能力
    // - 保持与现有 SOCKS5 CONNECT(TCP) 代码风格一致（中文日志 + 防御性校验）
    namespace Socks5Udp {

        // SOCKS5 UDP 头最大长度（不含 payload）：
        // RSV(2) + FRAG(1) + ATYP(1) + DOMAIN_LEN(1) + DOMAIN(255) + PORT(2) = 262
        constexpr size_t kMaxUdpHeaderBytes = 262;

        // 失败时输出少量字节摘要（避免刷屏/泄露敏感信息）
        inline std::string HexDump(const uint8_t* data, size_t len, size_t maxBytes) {
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

        inline std::string SockaddrToStringNoPort(const sockaddr* addr) {
            if (!addr) return "";
            if (addr->sa_family == AF_INET) {
                const auto* a4 = (const sockaddr_in*)addr;
                char buf[INET_ADDRSTRLEN] = {};
                if (!inet_ntop(AF_INET, &a4->sin_addr, buf, sizeof(buf))) return "";
                return std::string(buf);
            }
            if (addr->sa_family == AF_INET6) {
                const auto* a6 = (const sockaddr_in6*)addr;
                char buf[INET6_ADDRSTRLEN] = {};
                if (!inet_ntop(AF_INET6, &a6->sin6_addr, buf, sizeof(buf))) return "";
                return std::string(buf);
            }
            return "";
        }

        inline bool IsUnspecifiedAddr(const sockaddr* addr) {
            if (!addr) return true;
            if (addr->sa_family == AF_INET) {
                const auto* a4 = (const sockaddr_in*)addr;
                return a4->sin_addr.s_addr == 0; // 0.0.0.0
            }
            if (addr->sa_family == AF_INET6) {
                const auto* a6 = (const sockaddr_in6*)addr;
                static const in6_addr zero{};
                return memcmp(&a6->sin6_addr, &zero, sizeof(zero)) == 0; // ::
            }
            return true;
        }

        inline bool CopyPeerIpAsRelay(SOCKET tcpSock, uint16_t relayPort, sockaddr_storage* out, int* outLen) {
            if (!out || !outLen) return false;
            sockaddr_storage peer{};
            int peerLen = (int)sizeof(peer);
            if (getpeername(tcpSock, (sockaddr*)&peer, &peerLen) != 0) {
                return false;
            }
            if (peer.ss_family == AF_INET) {
                auto* a4 = (sockaddr_in*)&peer;
                a4->sin_port = htons(relayPort);
                memset(out, 0, sizeof(sockaddr_storage));
                memcpy(out, &peer, sizeof(sockaddr_in));
                *outLen = (int)sizeof(sockaddr_in);
                return true;
            }
            if (peer.ss_family == AF_INET6) {
                auto* a6 = (sockaddr_in6*)&peer;
                a6->sin6_port = htons(relayPort);
                memset(out, 0, sizeof(sockaddr_storage));
                memcpy(out, &peer, sizeof(sockaddr_in6));
                *outLen = (int)sizeof(sockaddr_in6);
                return true;
            }
            return false;
        }

        // 协商认证（支持 AUTH_NONE 与 RFC 1929 AUTH_USERPASS）
        inline bool NegotiateAuth(SOCKET tcpSock, const Core::ProxyConfig& config, int sendTimeoutMs, int recvTimeoutMs) {
            return Socks5Client::Authenticate(tcpSock, config, sendTimeoutMs, recvTimeoutMs, "SOCKS5 UDP");
        }

        // 保持向后兼容的无认证版本
        inline bool NegotiateNoAuth(SOCKET tcpSock, int sendTimeoutMs, int recvTimeoutMs) {
            Core::ProxyConfig emptyConfig{};
            return Socks5Client::Authenticate(tcpSock, emptyConfig, sendTimeoutMs, recvTimeoutMs, "SOCKS5 UDP");
        }

        struct UdpAssociateResult {
            SOCKET controlSock = INVALID_SOCKET;  // TCP 控制连接（调用方负责保持打开）
            sockaddr_storage relayAddr{};         // UDP Relay 地址（用于 connect/sendto）
            int relayAddrLen = 0;
        };

        // SOCKS5 UDP ASSOCIATE
        // - clientAddr/clientAddrLen 可为空：将使用 0.0.0.0:0 或 ::0:0（兼容多数实现）
        inline bool UdpAssociate(SOCKET tcpSock, const sockaddr* clientAddr, int clientAddrLen, UdpAssociateResult* out) {
            if (!out) return false;
            out->controlSock = tcpSock;
            out->relayAddrLen = 0;
            memset(&out->relayAddr, 0, sizeof(out->relayAddr));

            auto& config = Core::Config::Instance();
            const int recvTimeout = config.timeout.recv_ms;
            const int sendTimeout = config.timeout.send_ms;

            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("SOCKS5 UDP: 开始 UDP Associate, sock=" + std::to_string((unsigned long long)tcpSock));
            }

            if (!NegotiateAuth(tcpSock, config.proxy, sendTimeout, recvTimeout)) {
                return false;
            }

            // 2) UDP ASSOCIATE 请求
            // +----+-----+-------+------+----------+----------+
            // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
            // +----+-----+-------+------+----------+----------+
            // | 1  |  1  | X'00' |  1   | Variable |    2     |
            // +----+-----+-------+------+----------+----------+

            uint8_t atyp = Socks5::ATYP_IPV4;
            std::vector<uint8_t> addrBytes;
            uint16_t port = 0;

            // 默认：0.0.0.0:0（让服务端从 UDP 包源地址学习）
            in_addr zero4{};
            addrBytes.resize(4);
            memcpy(addrBytes.data(), &zero4, 4);

            if (clientAddr && (clientAddr->sa_family == AF_INET || clientAddr->sa_family == AF_INET6) &&
                clientAddrLen >= (int)sizeof(sockaddr)) {
                if (clientAddr->sa_family == AF_INET && clientAddrLen >= (int)sizeof(sockaddr_in)) {
                    const auto* a4 = (const sockaddr_in*)clientAddr;
                    atyp = Socks5::ATYP_IPV4;
                    addrBytes.resize(4);
                    memcpy(addrBytes.data(), &a4->sin_addr, 4);
                    port = ntohs(a4->sin_port);
                } else if (clientAddr->sa_family == AF_INET6 && clientAddrLen >= (int)sizeof(sockaddr_in6)) {
                    const auto* a6 = (const sockaddr_in6*)clientAddr;
                    atyp = Socks5::ATYP_IPV6;
                    addrBytes.resize(16);
                    memcpy(addrBytes.data(), &a6->sin6_addr, 16);
                    port = ntohs(a6->sin6_port);
                }
            }

            std::vector<uint8_t> request;
            request.reserve(4 + addrBytes.size() + 2);
            request.push_back(Socks5::VERSION);
            request.push_back(Socks5::CMD_UDP_ASSOCIATE);
            request.push_back(0x00); // RSV
            request.push_back(atyp);
            request.insert(request.end(), addrBytes.begin(), addrBytes.end());
            request.push_back((uint8_t)((port >> 8) & 0xFF));
            request.push_back((uint8_t)(port & 0xFF));

            if (!SocketIo::SendAll(tcpSock, (const char*)request.data(), (int)request.size(), sendTimeout)) {
                int err = WSAGetLastError();
                Core::Logger::Error("SOCKS5 UDP: 发送 UDP Associate 请求失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                    ", WSA错误码=" + std::to_string(err));
                return false;
            }

            // 3) 响应头
            uint8_t header[4] = {0, 0, 0, 0};
            if (!SocketIo::RecvExact(tcpSock, header, 4, recvTimeout)) {
                int err = WSAGetLastError();
                Core::Logger::Error("SOCKS5 UDP: 读取响应头失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                    ", WSA错误码=" + std::to_string(err));
                return false;
            }
            if (header[0] != Socks5::VERSION || header[2] != 0x00) {
                Core::Logger::Error("SOCKS5 UDP: 响应头无效, sock=" + std::to_string((unsigned long long)tcpSock) +
                                    ", bytes=" + HexDump(header, 4, 16));
                return false;
            }
            if (header[1] != Socks5::REPLY_SUCCESS) {
                Core::Logger::Error("SOCKS5 UDP: 服务器拒绝 UDP Associate, sock=" + std::to_string((unsigned long long)tcpSock) +
                                    ", REP=" + std::to_string(header[1]) +
                                    ", bytes=" + HexDump(header, 4, 16));
                return false;
            }

            const uint8_t repAtyp = header[3];
            sockaddr_storage relay{};
            int relayLen = 0;
            bool needUsePeerIp = false;
            uint16_t relayPort = 0;

            if (repAtyp == Socks5::ATYP_IPV4) {
                uint8_t ip4[4] = {};
                if (!SocketIo::RecvExact(tcpSock, ip4, 4, recvTimeout)) {
                    int err = WSAGetLastError();
                    Core::Logger::Error("SOCKS5 UDP: 读取 BND.IPv4 失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                        ", WSA错误码=" + std::to_string(err));
                    return false;
                }
                uint8_t portBuf[2] = {};
                if (!SocketIo::RecvExact(tcpSock, portBuf, 2, recvTimeout)) {
                    int err = WSAGetLastError();
                    Core::Logger::Error("SOCKS5 UDP: 读取 BND.PORT 失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                        ", WSA错误码=" + std::to_string(err));
                    return false;
                }
                relayPort = (uint16_t)((portBuf[0] << 8) | portBuf[1]);

                sockaddr_in a4{};
                a4.sin_family = AF_INET;
                memcpy(&a4.sin_addr, ip4, 4);
                a4.sin_port = htons(relayPort);
                memcpy(&relay, &a4, sizeof(a4));
                relayLen = (int)sizeof(a4);
                needUsePeerIp = (a4.sin_addr.s_addr == 0);
            } else if (repAtyp == Socks5::ATYP_IPV6) {
                uint8_t ip6[16] = {};
                if (!SocketIo::RecvExact(tcpSock, ip6, 16, recvTimeout)) {
                    int err = WSAGetLastError();
                    Core::Logger::Error("SOCKS5 UDP: 读取 BND.IPv6 失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                        ", WSA错误码=" + std::to_string(err));
                    return false;
                }
                uint8_t portBuf[2] = {};
                if (!SocketIo::RecvExact(tcpSock, portBuf, 2, recvTimeout)) {
                    int err = WSAGetLastError();
                    Core::Logger::Error("SOCKS5 UDP: 读取 BND.PORT 失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                        ", WSA错误码=" + std::to_string(err));
                    return false;
                }
                relayPort = (uint16_t)((portBuf[0] << 8) | portBuf[1]);

                sockaddr_in6 a6{};
                a6.sin6_family = AF_INET6;
                memcpy(&a6.sin6_addr, ip6, 16);
                a6.sin6_port = htons(relayPort);
                memcpy(&relay, &a6, sizeof(a6));
                relayLen = (int)sizeof(a6);
                needUsePeerIp = IsUnspecifiedAddr((sockaddr*)&a6);
            } else if (repAtyp == Socks5::ATYP_DOMAIN) {
                // 少见：返回域名。为避免引入 DNS/FakeIP 干扰，这里直接退化为使用 TCP peer IP。
                uint8_t dlen = 0;
                if (!SocketIo::RecvExact(tcpSock, &dlen, 1, recvTimeout)) {
                    int err = WSAGetLastError();
                    Core::Logger::Error("SOCKS5 UDP: 读取 BND.DOMAIN 长度失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                        ", WSA错误码=" + std::to_string(err));
                    return false;
                }
                if (dlen > 0) {
                    std::vector<uint8_t> trash(dlen);
                    if (!SocketIo::RecvExact(tcpSock, trash.data(), (int)trash.size(), recvTimeout)) {
                        int err = WSAGetLastError();
                        Core::Logger::Error("SOCKS5 UDP: 读取 BND.DOMAIN 失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                            ", WSA错误码=" + std::to_string(err));
                        return false;
                    }
                }
                uint8_t portBuf[2] = {};
                if (!SocketIo::RecvExact(tcpSock, portBuf, 2, recvTimeout)) {
                    int err = WSAGetLastError();
                    Core::Logger::Error("SOCKS5 UDP: 读取 BND.PORT 失败, sock=" + std::to_string((unsigned long long)tcpSock) +
                                        ", WSA错误码=" + std::to_string(err));
                    return false;
                }
                relayPort = (uint16_t)((portBuf[0] << 8) | portBuf[1]);
                needUsePeerIp = true;
            } else {
                Core::Logger::Error("SOCKS5 UDP: 未知 ATYP, sock=" + std::to_string((unsigned long long)tcpSock) +
                                    ", ATYP=" + std::to_string(repAtyp) +
                                    ", bytes=" + HexDump(header, 4, 16));
                return false;
            }

            if (needUsePeerIp) {
                sockaddr_storage peerRelay{};
                int peerRelayLen = 0;
                if (!CopyPeerIpAsRelay(tcpSock, relayPort, &peerRelay, &peerRelayLen)) {
                    Core::Logger::Error("SOCKS5 UDP: 获取 peer IP 作为 relay 失败, sock=" + std::to_string((unsigned long long)tcpSock));
                    return false;
                }
                relay = peerRelay;
                relayLen = peerRelayLen;
            }

            out->relayAddr = relay;
            out->relayAddrLen = relayLen;

            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                const std::string relayIp = SockaddrToStringNoPort((sockaddr*)&relay);
                Core::Logger::Debug("SOCKS5 UDP: relay 获取成功, sock=" + std::to_string((unsigned long long)tcpSock) +
                                    ", relay_ip=" + (relayIp.empty() ? std::string("(未知)") : relayIp) +
                                    ", relay_port=" + std::to_string(relayPort));
            }

            return true;
        }

        // UDP 封装结果（解封装时返回）
        struct UnwrapResult {
            sockaddr_storage src{};
            int srcLen = 0;
            const uint8_t* payload = nullptr;
            size_t payloadLen = 0;
        };

        // 将 host:port + payload 封装为 SOCKS5 UDP Request
        inline bool Wrap(const std::string& host, uint16_t port, const uint8_t* payload, size_t payloadLen, std::vector<uint8_t>* outPacket) {
            if (!outPacket) return false;
            outPacket->clear();

            // 解析 host -> ATYP + addrBytes
            uint8_t atyp = Socks5::ATYP_DOMAIN;
            std::vector<uint8_t> addrBytes;
            in_addr addr4{};
            in6_addr addr6{};
            if (!host.empty() && inet_pton(AF_INET, host.c_str(), &addr4) == 1) {
                atyp = Socks5::ATYP_IPV4;
                addrBytes.resize(4);
                memcpy(addrBytes.data(), &addr4, 4);
            } else if (!host.empty() && inet_pton(AF_INET6, host.c_str(), &addr6) == 1) {
                atyp = Socks5::ATYP_IPV6;
                addrBytes.resize(16);
                memcpy(addrBytes.data(), &addr6, 16);
            } else {
                // 域名
                if (host.size() > 255) {
                    Core::Logger::Error("SOCKS5 UDP: 域名过长，无法封装 (len=" + std::to_string(host.size()) + ")");
                    return false;
                }
                atyp = Socks5::ATYP_DOMAIN;
                addrBytes.reserve(1 + host.size());
                addrBytes.push_back((uint8_t)host.size());
                addrBytes.insert(addrBytes.end(), host.begin(), host.end());
            }

            // RSV(2) + FRAG(1) + ATYP(1) + DST.ADDR + DST.PORT(2) + DATA
            const size_t headerLen = 2 + 1 + 1 + addrBytes.size() + 2;
            outPacket->reserve(headerLen + payloadLen);
            outPacket->push_back(0x00);
            outPacket->push_back(0x00);
            outPacket->push_back(0x00); // FRAG=0（不支持分片）
            outPacket->push_back(atyp);
            outPacket->insert(outPacket->end(), addrBytes.begin(), addrBytes.end());
            outPacket->push_back((uint8_t)((port >> 8) & 0xFF));
            outPacket->push_back((uint8_t)(port & 0xFF));
            if (payload && payloadLen > 0) {
                outPacket->insert(outPacket->end(), payload, payload + payloadLen);
            }
            return true;
        }

        // 解封装 SOCKS5 UDP Reply：提取 src 地址与 payload 指针
        inline bool Unwrap(const uint8_t* packet, size_t packetLen, UnwrapResult* out) {
            if (!packet || packetLen < 10 || !out) return false;
            out->srcLen = 0;
            out->payload = nullptr;
            out->payloadLen = 0;
            memset(&out->src, 0, sizeof(out->src));

            // RSV(2)
            if (packet[0] != 0x00 || packet[1] != 0x00) {
                return false;
            }
            // FRAG
            if (packet[2] != 0x00) {
                // 当前实现不支持 SOCKS5 UDP 分片
                return false;
            }
            const uint8_t atyp = packet[3];
            size_t pos = 4;

            uint16_t port = 0;
            if (atyp == Socks5::ATYP_IPV4) {
                if (packetLen < pos + 4 + 2) return false;
                sockaddr_in a4{};
                a4.sin_family = AF_INET;
                memcpy(&a4.sin_addr, packet + pos, 4);
                pos += 4;
                port = (uint16_t)((packet[pos] << 8) | packet[pos + 1]);
                pos += 2;
                a4.sin_port = htons(port);
                memcpy(&out->src, &a4, sizeof(a4));
                out->srcLen = (int)sizeof(a4);
            } else if (atyp == Socks5::ATYP_IPV6) {
                if (packetLen < pos + 16 + 2) return false;
                sockaddr_in6 a6{};
                a6.sin6_family = AF_INET6;
                memcpy(&a6.sin6_addr, packet + pos, 16);
                pos += 16;
                port = (uint16_t)((packet[pos] << 8) | packet[pos + 1]);
                pos += 2;
                a6.sin6_port = htons(port);
                memcpy(&out->src, &a6, sizeof(a6));
                out->srcLen = (int)sizeof(a6);
            } else if (atyp == Socks5::ATYP_DOMAIN) {
                if (packetLen < pos + 1) return false;
                const uint8_t dlen = packet[pos++];
                if (packetLen < pos + dlen + 2) return false;
                // 域名无法直接塞进 sockaddr；这里跳过并返回 srcLen=0
                pos += dlen;
                port = (uint16_t)((packet[pos] << 8) | packet[pos + 1]);
                pos += 2;
            } else {
                return false;
            }

            if (packetLen < pos) return false;
            out->payload = packet + pos;
            out->payloadLen = packetLen - pos;
            return true;
        }
    } // namespace Socks5Udp
} // namespace Network
