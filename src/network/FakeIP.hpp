#pragma once
#include <string>
#include <map>
#include <mutex>
#include <winsock2.h>
#include <ws2tcpip.h>
#include "../core/Logger.hpp"

namespace Network {
    
    // FakeIP 管理器
    // 用于将域名映射到虚拟 IP (10.x.x.x)，并在 connect 时还原
    class FakeIP {
        std::map<uint32_t, std::string> m_ipToDomain;  // IP -> Domain 映射
        std::map<std::string, uint32_t> m_domainToIp;  // Domain -> IP 映射 (反向查找)
        std::mutex m_mtx;
        uint32_t m_nextIp;  // 下一个可分配的 IP (主机字节序)

    public:
        FakeIP() : m_nextIp(0x0A000001) {} // 10.0.0.1 开始
        
        static FakeIP& Instance() {
            static FakeIP instance;
            return instance;
        }
        
        // 检查是否为虚拟 IP (10.0.0.0/8 范围)
        bool IsFakeIP(uint32_t ipNetworkOrder) {
            uint32_t ip = ntohl(ipNetworkOrder);
            return (ip & 0xFF000000) == 0x0A000000; // 10.x.x.x
        }
        
        // 为域名分配虚拟 IP (如果已分配则返回现有 IP)
        uint32_t Alloc(const std::string& domain) {
            std::lock_guard<std::mutex> lock(m_mtx);
            
            // 检查是否已分配
            auto it = m_domainToIp.find(domain);
            if (it != m_domainToIp.end()) {
                return htonl(it->second);
            }
            
            // 分配新 IP
            uint32_t ip = m_nextIp++;
            m_ipToDomain[ip] = domain;
            m_domainToIp[domain] = ip;
            
            Core::Logger::Info("FakeIP: 已分配 " + IpToString(htonl(ip)) + " 给域名 " + domain);
            return htonl(ip); // 返回网络字节序
        }
        
        // 根据虚拟 IP 获取域名
        std::string GetDomain(uint32_t ipNetworkOrder) {
            std::lock_guard<std::mutex> lock(m_mtx);
            uint32_t ip = ntohl(ipNetworkOrder);
            
            auto it = m_ipToDomain.find(ip);
            if (it != m_ipToDomain.end()) {
                return it->second;
            }
            return "";
        }
        
        // 辅助函数：IP 转字符串
        static std::string IpToString(uint32_t ipNetworkOrder) {
            char buf[INET_ADDRSTRLEN];
            in_addr addr;
            addr.s_addr = ipNetworkOrder;
            inet_ntop(AF_INET, &addr, buf, sizeof(buf));
            return std::string(buf);
        }
    };
}
