#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>
#include <cstdint>
#include <chrono>
#include <limits>
#include <string>

namespace Network {
namespace SocketIo {

inline int NormalizeTimeoutMs(int timeoutMs) {
    return timeoutMs > 0 ? timeoutMs : 5000;
}

inline std::chrono::steady_clock::time_point BuildDeadline(int timeoutMs) {
    return std::chrono::steady_clock::now() + std::chrono::milliseconds(NormalizeTimeoutMs(timeoutMs));
}

inline int RemainingTimeoutMs(const std::chrono::steady_clock::time_point& deadline) {
    const auto now = std::chrono::steady_clock::now();
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
        return (std::numeric_limits<int>::max)();
    }
    return static_cast<int>(remainMs);
}

// 使用 select 等待可读/可写，避免非阻塞套接字直接失败
inline bool WaitReadable(SOCKET sock, int timeoutMs) {
    if (sock == INVALID_SOCKET) {
        WSASetLastError(WSAEINVAL);
        return false;
    }
    timeoutMs = NormalizeTimeoutMs(timeoutMs);
    fd_set readSet;
    FD_ZERO(&readSet);
    FD_SET(sock, &readSet);
    timeval tv{};
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    int rc = select(0, &readSet, nullptr, nullptr, &tv);
    if (rc > 0) return true;
    if (rc == 0) WSASetLastError(WSAETIMEDOUT);
    return false;
}

// 使用 select 等待可写，避免非阻塞套接字直接失败
inline bool WaitWritable(SOCKET sock, int timeoutMs) {
    if (sock == INVALID_SOCKET) {
        WSASetLastError(WSAEINVAL);
        return false;
    }
    timeoutMs = NormalizeTimeoutMs(timeoutMs);
    fd_set writeSet;
    FD_ZERO(&writeSet);
    FD_SET(sock, &writeSet);
    timeval tv{};
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    int rc = select(0, nullptr, &writeSet, nullptr, &tv);
    if (rc > 0) return true;
    if (rc == 0) WSASetLastError(WSAETIMEDOUT);
    return false;
}

// 等待连接完成并检查 SO_ERROR，适配非阻塞 connect
inline bool WaitConnect(SOCKET sock, int timeoutMs) {
    if (!WaitWritable(sock, timeoutMs)) return false;
    int soError = 0;
    int optLen = sizeof(soError);
    if (getsockopt(sock, SOL_SOCKET, SO_ERROR, (char*)&soError, &optLen) != 0) {
        return false;
    }
    if (soError != 0) {
        WSASetLastError(soError);
        return false;
    }
    return true;
}

// 确保完整发送，兼容非阻塞套接字
inline bool SendAll(SOCKET sock, const char* data, int len, int timeoutMs) {
    const auto deadline = BuildDeadline(timeoutMs);
    int totalSent = 0;
    while (totalSent < len) {
        int sent = send(sock, data + totalSent, len - totalSent, 0);
        if (sent > 0) {
            totalSent += sent;
            continue;
        }
        if (sent == 0) {
            WSASetLastError(WSAECONNRESET);
            return false;
        }
        int err = WSAGetLastError();
        if (err == WSAEWOULDBLOCK || err == WSAEINPROGRESS) {
            const int waitMs = RemainingTimeoutMs(deadline);
            if (waitMs <= 0) return false;
            if (!WaitWritable(sock, waitMs)) return false;
            continue;
        }
        return false;
    }
    return true;
}

// 精确接收指定字节数，兼容非阻塞套接字
inline bool RecvExact(SOCKET sock, uint8_t* buf, int len, int timeoutMs) {
    const auto deadline = BuildDeadline(timeoutMs);
    int totalRead = 0;
    while (totalRead < len) {
        int read = recv(sock, (char*)buf + totalRead, len - totalRead, 0);
        if (read > 0) {
            totalRead += read;
            continue;
        }
        if (read == 0) {
            WSASetLastError(WSAECONNRESET);
            return false;
        }
        int err = WSAGetLastError();
        if (err == WSAEWOULDBLOCK || err == WSAEINPROGRESS) {
            const int waitMs = RemainingTimeoutMs(deadline);
            if (waitMs <= 0) return false;
            if (!WaitReadable(sock, waitMs)) return false;
            continue;
        }
        return false;
    }
    return true;
}

// 逐字节接收直到命中分隔符，避免吞掉隧道首包数据
inline bool RecvUntil(SOCKET sock, std::string* out, const std::string& delimiter, int timeoutMs, int maxBytes) {
    if (!out) {
        WSASetLastError(WSAEINVAL);
        return false;
    }
    if (maxBytes <= 0) maxBytes = 1024;
    const auto deadline = BuildDeadline(timeoutMs);
    out->clear();
    out->reserve((size_t)maxBytes);
    while ((int)out->size() < maxBytes) {
        char ch = '\0';
        int read = recv(sock, &ch, 1, 0);
        if (read > 0) {
            out->push_back(ch);
            if (out->size() >= delimiter.size() &&
                out->find(delimiter) != std::string::npos) {
                return true;
            }
            continue;
        }
        if (read == 0) {
            WSASetLastError(WSAECONNRESET);
            return false;
        }
        int err = WSAGetLastError();
        if (err == WSAEWOULDBLOCK || err == WSAEINPROGRESS) {
            const int waitMs = RemainingTimeoutMs(deadline);
            if (waitMs <= 0) return false;
            if (!WaitReadable(sock, waitMs)) return false;
            continue;
        }
        return false;
    }
    WSASetLastError(WSAEMSGSIZE);
    return false;
}

} // namespace SocketIo
} // namespace Network
