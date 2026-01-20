#pragma once
#include <string>
#include <unordered_map>
#include <mutex>
#include <vector>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <sstream>
#include "../core/Config.hpp"
#include "../core/Logger.hpp"

namespace Network {
    
    // FakeIP 管理器 (Ring Buffer 策略)
    // 默认使用 198.18.0.0/15 (保留用于基准测试的网络，不容易冲突)
    class FakeIP {
        std::unordered_map<uint32_t, std::string> m_ipToDomain;  // IP(host order) -> Domain
        std::unordered_map<std::string, uint32_t> m_domainToIp;  // Domain -> IP(host order)
        std::mutex m_mtx;
        std::once_flag m_initOnce; // 用于线程安全的延迟初始化（避免 m_initialized 数据竞争）
        
        uint32_t m_baseIp;      // 网段起始 IP (host order)
        uint32_t m_mask;        // 子网掩码 (host order)
        uint32_t m_networkSize; // 可用 IP 数量
        uint32_t m_cursor;      // 当前分配游标 (0 ~ networkSize-1)

        // 线程安全的一次性初始化：确保 Config 已加载后再读取 CIDR
        void EnsureInitialized() {
            std::call_once(m_initOnce, [this]() {
                std::lock_guard<std::mutex> lock(m_mtx);

                auto& config = Core::Config::Instance();
                std::string cidr = config.fakeIp.cidr;
                if (cidr.empty()) cidr = "198.18.0.0/15";

                if (ParseCidr(cidr, m_baseIp, m_mask)) {
                    m_networkSize = ~m_mask + 1; // e.g. /24 -> 256
                    // 保留 .0 和最后一个地址（广播）? FakeIP 场景下通常都可以用，
                    // 但为了规避某些系统行为，跳过第0个和最后一个是个好习惯。
                    Core::Logger::Info("FakeIP: 初始化成功, CIDR=" + cidr +
                                       ", 容量=" + std::to_string(m_networkSize));
                } else {
                    Core::Logger::Error("FakeIP: CIDR 解析失败 (" + cidr + ")，回退到 198.18.0.0/15");
                    ParseCidr("198.18.0.0/15", m_baseIp, m_mask);
                    m_networkSize = ~m_mask + 1;
                }
            });
        }

        // CIDR 解析: "198.18.0.0/15" -> baseIp, mask
        bool ParseCidr(const std::string& cidr, uint32_t& outBase, uint32_t& outMask) {
            size_t slashPos = cidr.find('/');
            if (slashPos == std::string::npos) return false;

            std::string ipPart = cidr.substr(0, slashPos);
            std::string bitsPart = cidr.substr(slashPos + 1);
            
            int bits = std::stoi(bitsPart);
            if (bits < 0 || bits > 32) return false;

            in_addr addr;
            if (inet_pton(AF_INET, ipPart.c_str(), &addr) != 1) return false;

            outBase = ntohl(addr.s_addr);
            // 这里处理 bits=0 的边界情况
            if (bits == 0) outMask = 0;
            else outMask = 0xFFFFFFFF << (32 - bits);
            
            // 确保 base 是网段首地址
            outBase &= outMask; 
            return true;
        }

    public:
        FakeIP() : m_baseIp(0), m_mask(0), m_networkSize(0), m_cursor(1) {}
        
        static FakeIP& Instance() {
            static FakeIP instance;
            // 延迟初始化，确保 Config 已加载（线程安全）
            instance.EnsureInitialized();
            return instance;
        }
        
        void Init() {
            // 兼容旧调用：转为线程安全的一次性初始化
            EnsureInitialized();
        }

        // 检查是否为虚拟 IP
        bool IsFakeIP(uint32_t ipNetworkOrder) {
            EnsureInitialized();
            uint32_t ip = ntohl(ipNetworkOrder);
            return (ip & m_mask) == m_baseIp;
        }
        
        // 为域名分配虚拟 IP (Ring Buffer 策略)
        // 返回网络字节序 IP
        uint32_t Alloc(const std::string& domain) {
            EnsureInitialized();
            std::lock_guard<std::mutex> lock(m_mtx);
            
            // 1. 如果已存在映射，直接返回
            auto it = m_domainToIp.find(domain);
            if (it != m_domainToIp.end()) {
                // 可选：更新 LRU？Ring Buffer 不需要 LRU，由于空间只要够大，复用率低
                if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                    Core::Logger::Debug("FakeIP: 命中 " + domain + " -> " + IpToString(htonl(it->second)));
                }
                return htonl(it->second);
            }
            
            // 2. 分配新 IP
            if (m_networkSize <= 2) {
                // 防御性检查：网段过小会导致无法分配（此处记录告警便于排障）
                Core::Logger::Warn("FakeIP: 地址池过小，无法分配 (networkSize=" + std::to_string(m_networkSize) + ")");
                return 0;
            }

            // 游标移动
            uint32_t offset = m_cursor++;
            // 简单的 Ring Buffer: 超过范围回到 1
            if (m_cursor >= m_networkSize - 1) { 
                m_cursor = 1; 
                Core::Logger::Debug("FakeIP: 地址池循环回绕");
            }

            uint32_t newIp = m_baseIp | offset;

            // 3. 检查并清理旧映射 (Collision handling)
            auto oldIt = m_ipToDomain.find(newIp);
            if (oldIt != m_ipToDomain.end()) {
                // 把旧域名从反向表中移除
                m_domainToIp.erase(oldIt->second);
                if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                    Core::Logger::Debug("FakeIP: 回收 " + IpToString(htonl(newIp)) + " (原域名: " + oldIt->second + ")");
                }
            }

            // 4. 建立新映射
            m_ipToDomain[newIp] = domain;
            m_domainToIp[domain] = newIp;
            
            if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("FakeIP: 分配 " + IpToString(htonl(newIp)) + " -> " + domain);
            }
            return htonl(newIp);
        }
        
        // 根据虚拟 IP 获取域名
        std::string GetDomain(uint32_t ipNetworkOrder) {
            EnsureInitialized();
            std::lock_guard<std::mutex> lock(m_mtx);
            uint32_t ip = ntohl(ipNetworkOrder);
            
            auto it = m_ipToDomain.find(ip);
            if (it != m_ipToDomain.end()) {
                if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                    Core::Logger::Debug("FakeIP: 查询命中 " + IpToString(ipNetworkOrder) + " -> " + it->second);
                }
                return it->second;
            }

            // 如果是 FakeIP 网段内地址但查不到，通常意味着已回收/未分配或上下文不一致
            const bool isFake = ((ip & m_mask) == m_baseIp);
            if (isFake) {
                Core::Logger::Warn("FakeIP: 查询未命中 " + IpToString(ipNetworkOrder) + "，可能已回收或未分配");
            } else if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                Core::Logger::Debug("FakeIP: 查询非 FakeIP 地址 " + IpToString(ipNetworkOrder) + "，忽略");
            }
            return "";
        }
        
        // 辅助函数：IP 转字符串
        static std::string IpToString(uint32_t ipNetworkOrder) {
            char buf[INET_ADDRSTRLEN];
            in_addr addr;
            addr.s_addr = ipNetworkOrder;
            if (inet_ntop(AF_INET, &addr, buf, sizeof(buf))) {
                return std::string(buf);
            }
            return "";
        }
    };
}
