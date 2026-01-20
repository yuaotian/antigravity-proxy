#pragma once
#include <nlohmann/json.hpp>
#include <fstream>
#include <string>
#include <vector>
#include <algorithm>
#include <cctype>
#include "Logger.hpp"

namespace Core {
    struct ProxyConfig {
        std::string host = "127.0.0.1";
        int port = 7890;
        std::string type = "socks5";
    };

    struct FakeIPConfig {
        bool enabled = true;
        std::string cidr = "198.18.0.0/15";
        // 注：max_entries 已废弃，Ring Buffer 策略下自动循环复用地址池
    };

    struct TimeoutConfig {
        int connect_ms = 5000;
        int send_ms = 5000;
        int recv_ms = 5000;
    };

    // ============= 代理路由规则 =============
    // 用于控制哪些端口走代理、DNS 53 端口的特殊处理策略
    struct ProxyRules {
        // 允许代理的目标端口白名单（为空则代理所有端口）
        // 默认: 仅代理 HTTP(80) 和 HTTPS(443)
        std::vector<uint16_t> allowed_ports = {80, 443};
        
        // DNS (Port 53) 处理策略
        // "direct" - 直连, 不经代理 (默认, 解决 DNS 超时问题)
        // "proxy"  - 走代理
        std::string dns_mode = "direct";
        
        // IPv6 处理策略
        // "proxy"  - IPv6 走代理 (默认，兼容 IPv4/IPv6)
        // "direct" - IPv6 直连
        // "block"  - 阻止 IPv6 连接
        std::string ipv6_mode = "proxy";
        
        // 快速判断端口是否在白名单中
        bool IsPortAllowed(uint16_t port) const {
            if (allowed_ports.empty()) return true; // 空白名单 = 允许所有
            return std::find(allowed_ports.begin(), allowed_ports.end(), port) 
                   != allowed_ports.end();
        }
    };

    class Config {
    private:
        // 判断路径是否为绝对路径（Windows 盘符或 UNC 路径）
        static bool IsAbsolutePath(const std::string& path) {
            if (path.size() >= 2 && std::isalpha(static_cast<unsigned char>(path[0])) && path[1] == ':') {
                return true;
            }
            if (path.size() >= 2 &&
                ((path[0] == '\\' && path[1] == '\\') || (path[0] == '/' && path[1] == '/'))) {
                return true;
            }
            return false;
        }

        // 获取当前 DLL 所在目录（用于定位与 DLL 同目录的配置文件）
        static std::string GetModuleDirectory() {
            char modulePath[MAX_PATH] = {0};
            HMODULE hModule = NULL;
            if (!GetModuleHandleExA(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                reinterpret_cast<LPCSTR>(&GetModuleDirectory),
                &hModule
            )) {
                return "";
            }
            DWORD len = GetModuleFileNameA(hModule, modulePath, MAX_PATH);
            if (len == 0 || len >= MAX_PATH) {
                return "";
            }
            for (int i = static_cast<int>(len) - 1; i >= 0; --i) {
                if (modulePath[i] == '\\' || modulePath[i] == '/') {
                    modulePath[i] = '\0';
                    break;
                }
            }
            return std::string(modulePath);
        }

    public:
        ProxyConfig proxy;
        FakeIPConfig fakeIp;
        TimeoutConfig timeout;
        ProxyRules rules;               // 代理路由规则
        bool trafficLogging = false;    // Phase 3: 是否启用流量监控日志
        bool childInjection = true;     // Phase 2: 是否自动注入子进程
        std::vector<std::string> targetProcesses; // 目标进程列表 (空=全部)

        // 检查进程名是否在目标列表中 (大小写不敏感)
        bool ShouldInject(const std::string& processName) const {
            // 如果列表为空，注入所有进程
            if (targetProcesses.empty()) return true;
            
            // 将输入转为小写进行比较
            std::string lowerName = processName;
            std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), 
                [](unsigned char c) { return std::tolower(c); });
            
            for (const auto& target : targetProcesses) {
                std::string lowerTarget = target;
                std::transform(lowerTarget.begin(), lowerTarget.end(), lowerTarget.begin(),
                    [](unsigned char c) { return std::tolower(c); });
                
                // 支持完全匹配或不带扩展名匹配
                if (lowerName == lowerTarget) return true;
                // 支持类似 "language_server_windows" 匹配 "language_server_windows.exe"
                if (lowerName.find(lowerTarget) != std::string::npos) return true;
            }
            return false;
        }

        static Config& Instance() {
            static Config instance;
            return instance;
        }

        bool Load(const std::string& path = "config.json") {
            try {
                // 优先从 DLL 所在目录读取配置，避免子进程工作目录不同导致相对路径失效
                std::vector<std::string> candidates;
                if (IsAbsolutePath(path)) {
                    candidates.push_back(path);
                } else {
                    std::string dllDir = GetModuleDirectory();
                    if (!dllDir.empty()) {
                        candidates.push_back(dllDir + "\\" + path);
                    }
                    candidates.push_back(path);
                }

                std::ifstream f;
                std::string resolvedPath;
                for (const auto& candidate : candidates) {
                    f.open(candidate);
                    if (f.is_open()) {
                        resolvedPath = candidate;
                        break;
                    }
                    f.clear();
                }

                if (!f.is_open()) {
                    if (IsAbsolutePath(path)) {
                        Logger::Error("打开配置文件失败: " + path);
                    } else {
                        Logger::Error("打开配置文件失败: " + path + " (已尝试 DLL 目录与当前目录)");
                    }
                    return false;
                }
                nlohmann::json j = nlohmann::json::parse(f);

                // 日志等级：默认 info（更克制），允许通过配置切到 debug 以获得更细粒度排障信息
                // 设计意图：默认减少刷屏/IO 开销，现场需要时可提升日志粒度。
                const std::string logLevelStr = j.value("log_level", "info");
                if (!Logger::SetLevelFromString(logLevelStr)) {
                    Logger::SetLevel(LogLevel::Info);
                    Logger::Warn("配置: log_level 无效(" + logLevelStr + ")，已回退为 info (可选: debug/info/warn/error)");
                }
                if (!resolvedPath.empty()) {
                    Logger::Info("使用配置文件路径: " + resolvedPath);
                }
                
                if (j.contains("proxy")) {
                    auto& p = j["proxy"];
                    proxy.host = p.value("host", "127.0.0.1");
                    proxy.port = p.value("port", 7890);
                    proxy.type = p.value("type", "socks5");
                }

                // 配置校验：统一 proxy.type 大小写，并对关键字段做防御性修正，避免运行期异常
                std::transform(proxy.type.begin(), proxy.type.end(), proxy.type.begin(),
                               [](unsigned char c) { return (char)std::tolower(c); });
                if (proxy.type.empty()) proxy.type = "socks5";
                if (proxy.type != "socks5" && proxy.type != "http") {
                    Logger::Warn("配置: proxy.type 无效(" + proxy.type + ")，已回退为 socks5 (可选: socks5/http)");
                    proxy.type = "socks5";
                }
                if (proxy.host.empty()) {
                    Logger::Warn("配置: proxy.host 为空，已回退为 127.0.0.1");
                    proxy.host = "127.0.0.1";
                }
                if (proxy.port < 0 || proxy.port > 65535) {
                    Logger::Warn("配置: proxy.port 超出范围(" + std::to_string(proxy.port) + ")，已回退为 7890");
                    proxy.port = 7890;
                }

                if (j.contains("fake_ip")) {
                    auto& fip = j["fake_ip"];
                    fakeIp.enabled = fip.value("enabled", true);
                    fakeIp.cidr = fip.value("cidr", "198.18.0.0/15");
                    // max_entries 已废弃，Ring Buffer 策略下无需配置上限
                }

                if (j.contains("timeout")) {
                    auto& t = j["timeout"];
                    timeout.connect_ms = t.value("connect", 5000);
                    timeout.send_ms = t.value("send", 5000);
                    timeout.recv_ms = t.value("recv", 5000);
                }

                // 配置校验：超时必须为正数，避免 select/WaitConnect 异常行为
                if (timeout.connect_ms <= 0) {
                    Logger::Warn("配置: timeout.connect 非法(" + std::to_string(timeout.connect_ms) + ")，已回退为 5000");
                    timeout.connect_ms = 5000;
                }
                if (timeout.send_ms <= 0) {
                    Logger::Warn("配置: timeout.send 非法(" + std::to_string(timeout.send_ms) + ")，已回退为 5000");
                    timeout.send_ms = 5000;
                }
                if (timeout.recv_ms <= 0) {
                    Logger::Warn("配置: timeout.recv 非法(" + std::to_string(timeout.recv_ms) + ")，已回退为 5000");
                    timeout.recv_ms = 5000;
                }

                // ============= 代理路由规则解析 =============
                bool hasProxyRules = false;
                if (j.contains("proxy_rules")) {
                    hasProxyRules = true;
                    auto& pr = j["proxy_rules"];
                    // 解析端口白名单
                    if (pr.contains("allowed_ports") && pr["allowed_ports"].is_array()) {
                        rules.allowed_ports.clear();
                        for (const auto& p : pr["allowed_ports"]) {
                            if (p.is_number_unsigned()) {
                                rules.allowed_ports.push_back(static_cast<uint16_t>(p.get<unsigned int>()));
                            }
                        }
                    }
                    // 解析 DNS 策略
                    rules.dns_mode = pr.value("dns_mode", "direct");
                    std::transform(rules.dns_mode.begin(), rules.dns_mode.end(),
                                   rules.dns_mode.begin(),
                                   [](unsigned char c) { return (char)std::tolower(c); });
                    if (rules.dns_mode.empty()) rules.dns_mode = "direct";
                    // 解析 IPv6 策略，统一为小写，避免大小写导致配置失效
                    rules.ipv6_mode = pr.value("ipv6_mode", "proxy");
                    std::transform(rules.ipv6_mode.begin(), rules.ipv6_mode.end(),
                                   rules.ipv6_mode.begin(),
                                   [](unsigned char c) { return (char)std::tolower(c); });
                    if (rules.ipv6_mode.empty()) rules.ipv6_mode = "proxy";
                }
                // 配置校验：限制策略枚举取值，避免拼写错误导致绕过预期逻辑
                if (rules.dns_mode != "direct" && rules.dns_mode != "proxy") {
                    Logger::Warn("配置: proxy_rules.dns_mode 无效(" + rules.dns_mode + ")，已回退为 direct (可选: direct/proxy)");
                    rules.dns_mode = "direct";
                }
                if (rules.ipv6_mode != "proxy" && rules.ipv6_mode != "direct" && rules.ipv6_mode != "block") {
                    Logger::Warn("配置: proxy_rules.ipv6_mode 无效(" + rules.ipv6_mode + ")，已回退为 proxy (可选: proxy/direct/block)");
                    rules.ipv6_mode = "proxy";
                }
                Logger::Info("路由规则: allowed_ports=" + std::to_string(rules.allowed_ports.size()) + 
                             " 项, dns_mode=" + rules.dns_mode + ", ipv6_mode=" + rules.ipv6_mode +
                             (hasProxyRules ? "" : " (默认)"));


                // Phase 2/3 配置项
                trafficLogging = j.value("traffic_logging", false);
                childInjection = j.value("child_injection", true);

                // 目标进程列表
                if (j.contains("target_processes") && j["target_processes"].is_array()) {
                    targetProcesses.clear();
                    for (const auto& item : j["target_processes"]) {
                        if (item.is_string()) {
                            targetProcesses.push_back(item.get<std::string>());
                        }
                    }
                    Logger::Info("已加载目标进程列表, 共 " + std::to_string(targetProcesses.size()) + " 项");
                }

                Logger::Info("配置: proxy=" + proxy.host + ":" + std::to_string(proxy.port) +
                             " type=" + proxy.type +
                             ", fake_ip=" + std::string(fakeIp.enabled ? "true" : "false") +
                             ", child_injection=" + std::string(childInjection ? "true" : "false") +
                             ", traffic_logging=" + std::string(trafficLogging ? "true" : "false"));
                Logger::Info("配置加载成功。");
                return true;
            } catch (const std::exception& e) {
                Logger::Error(std::string("配置解析失败: ") + e.what());
                return false;
            }
        }
    };
}
