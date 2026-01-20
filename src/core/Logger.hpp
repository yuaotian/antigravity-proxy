#pragma once
#include <fstream>
#include <atomic>
#include <mutex>
#include <string>
#include <algorithm>
#include <cctype>
#include <iostream>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <ctime>
#include <iomanip>
#include <sstream>

namespace Core {
    // 日志等级（用于控制输出粒度：默认 Info；需要更细粒度排障时可切到 Debug）
    enum class LogLevel : int {
        Debug = 0,
        Info  = 1,
        Warn  = 2,
        Error = 3,
    };

    class Logger {
    private:
        // ========== 日志等级控制 ==========
        // 设计意图：默认 Info（更克制），现场需要时可切到 Debug；同时提供可配置降级能力以降低性能开销。
        static std::atomic<int>& LevelStorage() {
            static std::atomic<int> s_level{static_cast<int>(LogLevel::Info)};
            return s_level;
        }

        static bool TryParseLevelFromString(const std::string& input, LogLevel* out) {
            if (!out) return false;

            // 去掉首尾空白，并统一转小写（配置中常用 debug/info/warn/error）
            std::string s = input;
            auto notSpace = [](unsigned char c) { return !std::isspace(c); };
            s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
            s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
            std::transform(s.begin(), s.end(), s.begin(),
                           [](unsigned char c) { return (char)std::tolower(c); });

            if (s == "debug" || s == "d" || s == "trace" || s == "verbose" || s == "调试") {
                *out = LogLevel::Debug;
                return true;
            }
            if (s == "info" || s == "i" || s == "信息") {
                *out = LogLevel::Info;
                return true;
            }
            if (s == "warn" || s == "warning" || s == "w" || s == "警告") {
                *out = LogLevel::Warn;
                return true;
            }
            if (s == "error" || s == "err" || s == "e" || s == "错误") {
                *out = LogLevel::Error;
                return true;
            }
            return false;
        }

        // ========== 跨进程互斥（用于多进程注入场景下的日志一致性） ==========
        // 设计意图：序列化“检查大小→必要时截断→写入”这一段，避免多进程互相截断或写入交错。
        static HANDLE GetCrossProcessLogMutex() {
            static HANDLE s_mutex = NULL;
            static std::once_flag s_once;
            std::call_once(s_once, []() {
                // 使用 Local\ 命名空间：对普通桌面进程权限更稳
                s_mutex = CreateMutexA(NULL, FALSE, "Local\\AntigravityProxy_LogFileMutex");
            });
            return s_mutex;
        }

        // ========== 日志目录相关函数 ==========
        
        // 获取 DLL 所在目录（用于定位日志目录）
        static std::string GetDllDirectory() {
            char modulePath[MAX_PATH] = {0};
            HMODULE hModule = NULL;
            // 通过函数地址获取当前 DLL 的模块句柄
            if (!GetModuleHandleExA(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                reinterpret_cast<LPCSTR>(&GetDllDirectory),
                &hModule)) {
                return "";
            }
            DWORD len = GetModuleFileNameA(hModule, modulePath, MAX_PATH);
            if (len == 0 || len >= MAX_PATH) {
                return "";
            }
            // 截取路径，去掉文件名部分
            for (int i = static_cast<int>(len) - 1; i >= 0; --i) {
                if (modulePath[i] == '\\' || modulePath[i] == '/') {
                    modulePath[i] = '\0';
                    break;
                }
            }
            return std::string(modulePath);
        }

        // 确保目录存在，不存在则创建
        static bool EnsureLogDirectory(const std::string& dirPath) {
            DWORD attr = GetFileAttributesA(dirPath.c_str());
            if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
                return true; // 目录已存在
            }
            // 尝试创建目录
            return CreateDirectoryA(dirPath.c_str(), NULL) != 0;
        }

        // 获取系统临时目录路径
        static std::string GetSystemTempDirectory() {
            char tempPath[MAX_PATH] = {0};
            DWORD len = GetTempPathA(MAX_PATH, tempPath);
            if (len == 0 || len >= MAX_PATH) {
                return "";
            }
            // 去掉末尾的反斜杠（GetTempPathA 返回的路径末尾带 \）
            if (len > 0 && (tempPath[len - 1] == '\\' || tempPath[len - 1] == '/')) {
                tempPath[len - 1] = '\0';
            }
            return std::string(tempPath);
        }

        // 获取日志目录路径，首次调用时初始化
        // 优先级：DLL目录/logs/ → 系统TEMP目录/antigravity-proxy-logs/
        static std::string GetLogDirectory() {
            static std::string s_logDir;
            static bool s_initialized = false;
            if (!s_initialized) {
                s_initialized = true;
                // 优先尝试 DLL 目录下的 logs 子目录
                std::string dllDir = GetDllDirectory();
                if (!dllDir.empty()) {
                    std::string dllLogs = dllDir + "\\logs";
                    if (EnsureLogDirectory(dllLogs)) {
                        s_logDir = dllLogs;
                        return s_logDir;
                    }
                }
                // 回退到系统 TEMP 目录
                std::string tempDir = GetSystemTempDirectory();
                if (!tempDir.empty()) {
                    std::string tempLogs = tempDir + "\\antigravity-proxy-logs";
                    if (EnsureLogDirectory(tempLogs)) {
                        s_logDir = tempLogs;
                    }
                }
                // 如果都失败，s_logDir 保持为空，日志将写入当前目录（最后手段）
            }
            return s_logDir;
        }

        // ========== 原有辅助函数 ==========
        
        static std::string GetTimestamp() {
            auto now = std::time(nullptr);
            struct tm tm;
            localtime_s(&tm, &now);
            std::ostringstream oss;
            oss << std::put_time(&tm, "%Y-%m-%d %H:%M:%S");
            return oss.str();
        }

        static std::string GetPidTidPrefix() {
            // 在多进程/多线程混写同一个日志文件时，PID/TID 有助于定位来源
            DWORD pid = GetCurrentProcessId();
            DWORD tid = GetCurrentThreadId();
            return "[PID:" + std::to_string(pid) + "][TID:" + std::to_string(tid) + "]";
        }

        // 获取今日日志文件完整路径（如：C:\xxx\logs\proxy-20260111.log）
        static std::string GetTodayLogName() {
            auto now = std::time(nullptr);
            struct tm tm;
            localtime_s(&tm, &now);
            std::ostringstream oss;
            // 优先使用 DLL 目录下的 logs 子目录
            std::string logDir = GetLogDirectory();
            if (!logDir.empty()) {
                oss << logDir << "\\";
            }
            oss << "proxy-" << std::put_time(&tm, "%Y%m%d") << ".log";
            return oss.str();
        }

        static bool IsLogOverLimit(const std::string& path, ULONGLONG maxBytes) {
            WIN32_FILE_ATTRIBUTE_DATA data{};
            if (!GetFileAttributesExA(path.c_str(), GetFileExInfoStandard, &data)) {
                return false;
            }
            ULONGLONG size = (static_cast<ULONGLONG>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
            return size >= maxBytes;
        }

        static ULONGLONG GetFileSizeBytes(const std::string& path) {
            WIN32_FILE_ATTRIBUTE_DATA data{};
            if (!GetFileAttributesExA(path.c_str(), GetFileExInfoStandard, &data)) {
                return 0;
            }
            return (static_cast<ULONGLONG>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
        }

        // 清理旧日志文件，只保留当天的日志
        static void CleanupOldLogs(const std::string& todayLog) {
            std::string logDir = GetLogDirectory();
            // 构建搜索模式（支持有/无日志目录两种情况）
            std::string searchPattern = logDir.empty() 
                ? "proxy-*.log" 
                : (logDir + "\\proxy-*.log");
            
            WIN32_FIND_DATAA findData{};
            HANDLE hFind = FindFirstFileA(searchPattern.c_str(), &findData);
            if (hFind != INVALID_HANDLE_VALUE) {
                do {
                    if (findData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                        continue;
                    }
                    // 构建找到文件的完整路径
                    std::string fullPath = logDir.empty() 
                        ? std::string(findData.cFileName) 
                        : (logDir + "\\" + findData.cFileName);
                    
                    // 保留今天的日志，删除其他日期的
                    if (todayLog != fullPath) {
                        DeleteFileA(fullPath.c_str());
                    }
                } while (FindNextFileA(hFind, &findData));
                FindClose(hFind);
            }
            // 清理旧版日志文件（无日期后缀的遗留文件）
            std::string oldLog = logDir.empty() ? "proxy.log" : (logDir + "\\proxy.log");
            std::string oldLog1 = logDir.empty() ? "proxy.log.1" : (logDir + "\\proxy.log.1");
            if (todayLog != oldLog) {
                DeleteFileA(oldLog.c_str());
            }
            DeleteFileA(oldLog1.c_str());
        }

        static void WriteToFile(const std::string& message) {
            // 按日期写日志并清理旧文件，避免历史日志堆积
            static std::string s_todayLog;
            // 需求：单文件 10MB 达到即覆盖写入（不轮转、不备份）
            static const ULONGLONG kMaxLogBytes = 10ull * 1024 * 1024; // 10MB

            // 多进程注入场景：使用跨进程互斥量保证“检查+截断+写入”的原子性
            HANDLE hMutex = GetCrossProcessLogMutex();
            DWORD waitRc = WAIT_FAILED;
            if (hMutex) {
                waitRc = WaitForSingleObject(hMutex, INFINITE);
            }
            const bool locked = (hMutex != NULL) && (waitRc == WAIT_OBJECT_0 || waitRc == WAIT_ABANDONED);

            // 如果跨进程互斥不可用，退化为进程内互斥，保证不崩溃（但多进程一致性会弱一些）
            static std::mutex s_fallbackMtx;
            std::unique_lock<std::mutex> fallbackLock;
            if (!locked) {
                fallbackLock = std::unique_lock<std::mutex>(s_fallbackMtx);
            }

            std::string todayLog = GetTodayLogName();
            if (s_todayLog != todayLog) {
                s_todayLog = todayLog;
                CleanupOldLogs(s_todayLog);
            }

            // 判断本次写入是否会超过上限；超过则直接截断覆盖写入
            const ULONGLONG currentSize = GetFileSizeBytes(s_todayLog);
            const ULONGLONG appendBytes = static_cast<ULONGLONG>(message.size() + 1); // + '\n'
            const bool needTruncate = (currentSize > 0 && (currentSize + appendBytes) > kMaxLogBytes);

            std::ofstream logFile;
            if (needTruncate) {
                logFile.open(s_todayLog, std::ios::out | std::ios::trunc);
            } else {
                logFile.open(s_todayLog, std::ios::out | std::ios::app);
            }
            if (logFile.is_open()) {
                logFile << message << "\n";
            }

            if (locked) {
                ReleaseMutex(hMutex);
            }
        }

    public:
        // 判断某个等级的日志是否会输出（用于调用方做“懒构造字符串”，减少性能开销）
        static bool IsEnabled(LogLevel level) {
            const int threshold = LevelStorage().load(std::memory_order_relaxed);
            return static_cast<int>(level) >= threshold;
        }

        static LogLevel GetLevel() {
            return static_cast<LogLevel>(LevelStorage().load(std::memory_order_relaxed));
        }

        static void SetLevel(LogLevel level) {
            LevelStorage().store(static_cast<int>(level), std::memory_order_relaxed);
        }

        // 从字符串设置日志等级；返回是否识别成功（不识别则不修改当前等级）
        static bool SetLevelFromString(const std::string& levelStr) {
            LogLevel parsed;
            if (!TryParseLevelFromString(levelStr, &parsed)) {
                return false;
            }
            SetLevel(parsed);
            return true;
        }

        static void Log(const std::string& message) {
            // 将无等级的 Log 视为 Info 级别，确保可被 log_level 控制
            if (!IsEnabled(LogLevel::Info)) return;
            WriteToFile("[" + GetTimestamp() + "] " + GetPidTidPrefix() + " " + message);
        }

        static void Error(const std::string& message) {
            if (!IsEnabled(LogLevel::Error)) return;
            WriteToFile("[" + GetTimestamp() + "] " + GetPidTidPrefix() + " [错误] " + message);
        }

        static void Info(const std::string& message) {
            if (!IsEnabled(LogLevel::Info)) return;
            WriteToFile("[" + GetTimestamp() + "] " + GetPidTidPrefix() + " [信息] " + message);
        }

        static void Warn(const std::string& message) {
            if (!IsEnabled(LogLevel::Warn)) return;
            WriteToFile("[" + GetTimestamp() + "] " + GetPidTidPrefix() + " [警告] " + message);
        }

        static void Debug(const std::string& message) {
            if (!IsEnabled(LogLevel::Debug)) return;
            WriteToFile("[" + GetTimestamp() + "] " + GetPidTidPrefix() + " [调试] " + message);
        }
    };
}
