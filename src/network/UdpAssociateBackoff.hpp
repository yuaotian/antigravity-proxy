#pragma once
#include <cstdint>
#include <mutex>

namespace Network {

// SOCKS5 UDP ASSOCIATE 失败退避（进程级）。
// 代理软件未开启 UDP（或不支持 UDP ASSOCIATE）时，每个新 UDP socket 都会重建一条 TCP 控制连接再失败，
// 白白增加握手耗时与日志噪音。失败后在 windowMs 内直接按 udp_fallback 处理，且每个窗口只提示一次。
// 纯逻辑、不依赖 Winsock，便于单元测试；时间由调用方传入（GetTickCount64 毫秒）。
class UdpAssociateBackoff {
public:
    explicit UdpAssociateBackoff(uint64_t windowMs = 60000) : m_windowMs(windowMs) {}

    // 当前是否处于退避期：是则跳过 ASSOCIATE，直接按 fallback 处理
    bool ShouldSkip(uint64_t nowMs) const {
        std::lock_guard<std::mutex> lock(m_mtx);
        return nowMs < m_until;
    }

    // 记录一次失败并开启（或延长）退避窗口；返回 true 表示这是新窗口的首次失败，调用方据此只输出一次提示
    bool RecordFailure(uint64_t nowMs) {
        std::lock_guard<std::mutex> lock(m_mtx);
        const bool firstInWindow = nowMs >= m_until;
        m_until = nowMs + m_windowMs;
        return firstInWindow;
    }

    // ASSOCIATE 成功：立即结束退避（例如用户在代理软件中开启了 UDP）
    void RecordSuccess() {
        std::lock_guard<std::mutex> lock(m_mtx);
        m_until = 0;
    }

private:
    mutable std::mutex m_mtx;
    uint64_t m_windowMs;
    uint64_t m_until = 0;
};

}  // namespace Network
