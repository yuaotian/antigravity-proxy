#pragma once

// IDE 配套插件检测的纯逻辑（无 Win32 UI / 文件 IO，便于单元测试）。
// 由 IdeExtensionPrompt.cpp 组合使用：判断是否 IDE 主进程、解析命令行参数、定位扩展目录、判断插件是否已安装。

#include <algorithm>
#include <cctype>
#include <cwctype>
#include <string>
#include <vector>

namespace IdeExtension {

// 插件标识（publisher.name），与 resources/ide-extension/package.json 一致
inline const char* ExtensionId() { return "yuaotian.antigravity-proxy"; }

inline bool EqualsIgnoreCase(const std::wstring& a, const std::wstring& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (std::towlower(a[i]) != std::towlower(b[i])) return false;
    }
    return true;
}

// 按 Windows 命令行规则做简化切分：空白分隔、双引号包裹的部分保留空白，结果中去掉引号。
// 只用于读取 --extensions-dir / --user-data-dir 这类路径参数，不追求覆盖全部转义细节。
inline std::vector<std::wstring> SplitCommandLine(const std::wstring& cmd) {
    std::vector<std::wstring> out;
    std::wstring cur;
    bool inQuotes = false;
    bool hasToken = false;
    for (wchar_t ch : cmd) {
        if (ch == L'"') {
            inQuotes = !inQuotes;
            hasToken = true;
            continue;
        }
        if (!inQuotes && (ch == L' ' || ch == L'\t')) {
            if (hasToken) {
                out.push_back(cur);
                cur.clear();
                hasToken = false;
            }
            continue;
        }
        cur.push_back(ch);
        hasToken = true;
    }
    if (hasToken) out.push_back(cur);
    return out;
}

// 读取形如 --name=value 或 --name value 的参数值；不存在返回空串
inline std::wstring GetArgValue(const std::wstring& cmd, const std::wstring& name) {
    const std::vector<std::wstring> args = SplitCommandLine(cmd);
    const std::wstring prefix = name + L"=";
    for (size_t i = 0; i < args.size(); ++i) {
        if (args[i].size() > prefix.size() && EqualsIgnoreCase(args[i].substr(0, prefix.size()), prefix)) {
            return args[i].substr(prefix.size());
        }
        if (EqualsIgnoreCase(args[i], name) && i + 1 < args.size()) {
            return args[i + 1];
        }
    }
    return L"";
}

// 是否为 Antigravity IDE 的主（浏览器）进程：
// - 进程名必须是 Antigravity IDE.exe（桌面版 Antigravity.exe 与 CLI 不加载 VS Code 插件）
// - Electron 子进程（渲染/GPU/网络/扩展宿主等）命令行都带 --type=，主进程没有
// - ELECTRON_RUN_AS_NODE=1 表示以 Node 模式运行（IDE 命令行工具 antigravity-ide.cmd），不是界面进程
inline bool IsIdeMainProcess(const std::wstring& exeBaseName, const std::wstring& cmdLine, bool runAsNode) {
    if (runAsNode) return false;
    if (!EqualsIgnoreCase(exeBaseName, L"Antigravity IDE.exe")) return false;
    return cmdLine.find(L"--type=") == std::wstring::npos;
}

// 从 product.json 文本中读取 dataFolderName（用户数据目录名，如 ".antigravity-ide"）；读取失败返回默认值
inline std::string ParseDataFolderName(const std::string& productJson) {
    const std::string key = "\"dataFolderName\"";
    const size_t k = productJson.find(key);
    if (k != std::string::npos) {
        const size_t colon = productJson.find(':', k + key.size());
        const size_t q1 = colon == std::string::npos ? std::string::npos : productJson.find('"', colon + 1);
        const size_t q2 = q1 == std::string::npos ? std::string::npos : productJson.find('"', q1 + 1);
        if (q2 != std::string::npos && q2 > q1 + 1) {
            const std::string value = productJson.substr(q1 + 1, q2 - q1 - 1);
            // 只接受普通目录名，防止异常内容拼出越界路径
            if (value.find_first_of("\\/:*?<>|") == std::string::npos && value != "." && value != "..") return value;
        }
    }
    return ".antigravity-ide";
}

// extensions.json（VS Code 扩展清单）中是否登记了指定插件（大小写不敏感）
inline bool ExtensionsJsonHasId(std::string json, std::string id) {
    auto lower = [](std::string s) {
        std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return s;
    };
    return lower(json).find("\"" + lower(id) + "\"") != std::string::npos;
}

}  // namespace IdeExtension
