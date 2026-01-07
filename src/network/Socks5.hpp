#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>
#include <string>
#include "../core/Logger.hpp"

namespace Network {
    
    // SOCKS5 协议常量
    namespace Socks5 {
        constexpr uint8_t VERSION = 0x05;
        constexpr uint8_t AUTH_NONE = 0x00;
        constexpr uint8_t CMD_CONNECT = 0x01;
        constexpr uint8_t ATYP_IPV4 = 0x01;
        constexpr uint8_t ATYP_DOMAIN = 0x03;
        constexpr uint8_t ATYP_IPV6 = 0x04;
        constexpr uint8_t REPLY_SUCCESS = 0x00;
    }
    
    class Socks5Client {
    public:
        // 执行 SOCKS5 握手 (无认证模式)
        // 返回 true 表示成功建立隧道
        static bool Handshake(SOCKET sock, const std::string& targetHost, uint16_t targetPort) {
            // 第一步：发送认证方法协商
            // +----+----------+----------+
            // |VER | NMETHODS | METHODS  |
            // +----+----------+----------+
            // | 1  |    1     | 1 to 255 |
            // +----+----------+----------+
            uint8_t authRequest[3] = { Socks5::VERSION, 0x01, Socks5::AUTH_NONE };
            if (send(sock, (char*)authRequest, 3, 0) != 3) {
                Core::Logger::Error("SOCKS5: Failed to send auth request");
                return false;
            }
            
            // 接收认证方法响应
            uint8_t authResponse[2];
            if (recv(sock, (char*)authResponse, 2, 0) != 2) {
                Core::Logger::Error("SOCKS5: Failed to receive auth response");
                return false;
            }
            
            if (authResponse[0] != Socks5::VERSION || authResponse[1] != Socks5::AUTH_NONE) {
                Core::Logger::Error("SOCKS5: Auth method not supported");
                return false;
            }
            
            // 第二步：发送连接请求
            // +----+-----+-------+------+----------+----------+
            // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
            // +----+-----+-------+------+----------+----------+
            // | 1  |  1  | X'00' |  1   | Variable |    2     |
            // +----+-----+-------+------+----------+----------+
            
            std::vector<uint8_t> connectRequest;
            connectRequest.push_back(Socks5::VERSION);
            connectRequest.push_back(Socks5::CMD_CONNECT);
            connectRequest.push_back(0x00); // RSV
            
            // 判断目标是 IP 还是域名
            in_addr addr;
            if (inet_pton(AF_INET, targetHost.c_str(), &addr) == 1) {
                // IPv4 地址
                connectRequest.push_back(Socks5::ATYP_IPV4);
                connectRequest.push_back((addr.s_addr >> 0) & 0xFF);
                connectRequest.push_back((addr.s_addr >> 8) & 0xFF);
                connectRequest.push_back((addr.s_addr >> 16) & 0xFF);
                connectRequest.push_back((addr.s_addr >> 24) & 0xFF);
            } else {
                // 域名
                connectRequest.push_back(Socks5::ATYP_DOMAIN);
                connectRequest.push_back(static_cast<uint8_t>(targetHost.length()));
                for (char c : targetHost) {
                    connectRequest.push_back(static_cast<uint8_t>(c));
                }
            }
            
            // 端口 (网络字节序)
            connectRequest.push_back((targetPort >> 8) & 0xFF);
            connectRequest.push_back(targetPort & 0xFF);
            
            if (send(sock, (char*)connectRequest.data(), (int)connectRequest.size(), 0) != (int)connectRequest.size()) {
                Core::Logger::Error("SOCKS5: Failed to send connect request");
                return false;
            }
            
            // 接收连接响应
            uint8_t connectResponse[10]; // 最小响应长度 (IPv4)
            int received = recv(sock, (char*)connectResponse, 10, 0);
            if (received < 10) {
                Core::Logger::Error("SOCKS5: Failed to receive connect response");
                return false;
            }
            
            if (connectResponse[0] != Socks5::VERSION) {
                Core::Logger::Error("SOCKS5: Invalid version in response");
                return false;
            }
            
            if (connectResponse[1] != Socks5::REPLY_SUCCESS) {
                Core::Logger::Error("SOCKS5: Connection failed, reply code: " + std::to_string(connectResponse[1]));
                return false;
            }
            
            Core::Logger::Info("SOCKS5: Tunnel established to " + targetHost + ":" + std::to_string(targetPort));
            return true;
        }
    };
}
