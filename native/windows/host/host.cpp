// bunaway Windows product host: Win32 window + WebView2 + bundled Bun child process.
//
// Trust boundary: the WebView2 page is untrusted input. The native host observes the
// real origin/top-level document, issues opaque contexts, enforces the package policy
// and re-checks file access at the actual open boundary. Web payload fields can never
// choose a context, permissions or internal control frames.
#include <windows.h>
#include <bcrypt.h>
#include <fcntl.h>
#include <io.h>
#include <shlobj.h>
#include <wrl.h>
#include "WebView2.h"
#include "json.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cctype>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <vector>

using Json = nlohmann::json;
namespace fs = std::filesystem;
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

constexpr size_t maxFrame = 1'048'576;
constexpr size_t maxDepth = 64;
constexpr size_t maxSendQueue = 128;
constexpr size_t maxPendingWeb = 128;
constexpr size_t maxRequestIds = 1024;
constexpr size_t maxSubscriptions = 128;
constexpr size_t maxFileBytes = 4 * 1024 * 1024;
constexpr ULONGLONG readyDeadlineMs = 10'000;
constexpr ULONGLONG shutdownDeadlineMs = 2'000;
constexpr ULONGLONG ioJoinDeadlineMs = 2'000;
constexpr ULONGLONG maxCommandMs = 30'000;
const Json ipc = { { "major", 1 }, { "minor", 0 } };

#define WM_APP_WEB_MESSAGE (WM_APP + 1)
#define WM_APP_RUNTIME_FAILED (WM_APP + 2)
#define WM_APP_RUNTIME_EXITED (WM_APP + 3)

void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value(other.value) { other.value = nullptr; }
    Handle& operator=(Handle&& other) noexcept { reset(other.value); other.value = nullptr; return *this; }
    ~Handle() { reset(); }
    void reset(HANDLE h = nullptr) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = h; }
};

std::string utf8(const std::wstring& value) {
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    require(n > 0 || value.empty(), "Invalid path encoding.");
    std::string result(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), n, nullptr, nullptr);
    return result;
}

std::wstring utf16(const std::string& value) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    require(n > 0 || value.empty(), "Invalid UTF-8.");
    std::wstring result(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), n);
    return result;
}

size_t unicodeSize(const std::string& value) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    require(n > 0 || value.empty(), "Invalid UTF-8.");
    size_t count = 0;
    for (unsigned char byte : value) if ((byte & 0xc0) != 0x80) ++count;
    return count;
}

Json parse(const std::string& text) {
    require(!text.empty() && text.size() <= maxFrame, "Invalid frame length.");
    return Json::parse(text, [](int depth, Json::parse_event_t event, Json& value) {
        require(depth <= maxDepth, "JSON depth exceeded.");
        if (event == Json::parse_event_t::value && value.is_number()) {
            double number = value.get<double>();
            require(std::isfinite(number), "Non-finite JSON number.");
            if (std::floor(number) == number && std::abs(number) <= 9007199254740991.0) value = static_cast<int64_t>(number);
            else value = number;
        }
        return true;
    });
}

Json readJson(const fs::path& path) {
    std::ifstream input(path, std::ios::binary);
    require(input.good(), "Package asset missing.");
    return parse(std::string(std::istreambuf_iterator<char>(input), {}));
}

// Same JSON Schema subset as the B probe: conditions combine, patterns are UTF-8 byte
// regexes, maxLength counts Unicode code points. New schema keywords need this validator.
bool valid(const Json& schema, const Json& value) {
    if (schema.contains("anyOf")) {
        bool found = false;
        for (const auto& variant : schema["anyOf"]) if (valid(variant, value)) { found = true; break; }
        if (!found) return false;
    }
    if (schema.contains("const") && schema["const"] != value) return false;
    if (schema.contains("enum")) {
        bool found = false;
        for (const auto& candidate : schema["enum"]) found |= candidate == value;
        if (!found) return false;
    }
    auto type = schema.value("type", "");
    if (type.empty()) {
        if (value.is_object()) type = "object";
        else if (value.is_array()) type = "array";
        else if (value.is_string()) type = "string";
        else if (value.is_number()) type = "number";
    }
    if (type == "object") {
        if (!value.is_object()) return false;
        for (const auto& key : schema.value("required", Json::array())) if (!value.contains(key.get<std::string>())) return false;
        auto properties = schema.value("properties", Json::object());
        for (auto it = value.begin(); it != value.end(); ++it) {
            if (!properties.contains(it.key())) {
                if (schema.contains("additionalProperties") && schema["additionalProperties"] == false) return false;
            } else if (!valid(properties[it.key()], it.value())) return false;
        }
    } else if (type == "array") {
        if (!value.is_array()) return false;
        if (schema.contains("minItems") && value.size() < schema["minItems"].get<size_t>()) return false;
        if (schema.contains("maxItems") && value.size() > schema["maxItems"].get<size_t>()) return false;
        for (size_t i = 0; i < value.size(); ++i) {
            if (schema.contains("items") && !valid(schema["items"], value[i])) return false;
            if (schema.value("uniqueItems", false)) for (size_t j = 0; j < i; ++j) if (value[i] == value[j]) return false;
        }
    } else if (type == "string") {
        if (!value.is_string()) return false;
        const auto& string = value.get_ref<const std::string&>();
        if (schema.contains("maxLength") && unicodeSize(string) > schema["maxLength"].get<size_t>()) return false;
        if (schema.contains("pattern") && !std::regex_search(string, std::regex(schema["pattern"].get<std::string>()))) return false;
    } else if (type == "integer" || type == "number") {
        if (!value.is_number() || !std::isfinite(value.get<double>())) return false;
        if (type == "integer" && (std::floor(value.get<double>()) != value.get<double>() || std::abs(value.get<double>()) > 9007199254740991.0)) return false;
        if (schema.contains("minimum") && value.get<double>() < schema["minimum"].get<double>()) return false;
        if (schema.contains("maximum") && value.get<double>() > schema["maximum"].get<double>()) return false;
    } else if (type == "boolean" && !value.is_boolean()) return false;
    return true;
}

std::string sha256(const fs::path& path) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0, "Hash init failed.");
    struct AlgorithmGuard { BCRYPT_ALG_HANDLE h; ~AlgorithmGuard() { BCryptCloseAlgorithmProvider(h, 0); } } guard { algorithm };
    BCRYPT_HASH_HANDLE hash = nullptr;
    require(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0, "Hash creation failed.");
    struct HashGuard { BCRYPT_HASH_HANDLE h; ~HashGuard() { BCryptDestroyHash(h); } } hashGuard { hash };
    std::ifstream input(path, std::ios::binary);
    require(input.good(), "Hash asset missing.");
    char buffer[65536];
    while (input.read(buffer, sizeof buffer) || input.gcount()) {
        require(BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer), static_cast<ULONG>(input.gcount()), 0) == 0, "Hash update failed.");
    }
    require(input.eof(), "Hash read failed.");
    UCHAR digest[32];
    require(BCryptFinishHash(hash, digest, sizeof digest, 0) == 0, "Hash finish failed.");
    std::string result;
    for (UCHAR byte : digest) { result += "0123456789abcdef"[byte >> 4]; result += "0123456789abcdef"[byte & 15]; }
    return result;
}

std::string randomHex(size_t bytes) {
    std::vector<UCHAR> raw(bytes);
    require(BCryptGenRandom(nullptr, raw.data(), static_cast<ULONG>(raw.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "Random generation failed.");
    std::string result;
    for (UCHAR byte : raw) { result += "0123456789abcdef"[byte >> 4]; result += "0123456789abcdef"[byte & 15]; }
    return result;
}

std::wstring quote(const std::wstring& arg) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') { slashes++; continue; }
        result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        result += c;
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L'"';
}

void writeAll(HANDLE pipe, const std::string& text) {
    size_t offset = 0;
    while (offset < text.size()) {
        DWORD written = 0;
        require(WriteFile(pipe, text.data() + offset, static_cast<DWORD>(text.size() - offset), &written, nullptr) && written, "Pipe write failed.");
        offset += written;
    }
}

template<typename F> void readLines(HANDLE pipe, F receive) {
    std::string pending;
    char buffer[8192];
    DWORD length = 0;
    for (;;) {
        if (!ReadFile(pipe, buffer, sizeof buffer, &length, nullptr)) {
            auto error = GetLastError();
            require(error == ERROR_BROKEN_PIPE || error == ERROR_OPERATION_ABORTED, "Pipe read failed.");
            break;
        }
        if (!length) break;
        for (DWORD i = 0; i < length; ++i) {
            if (buffer[i] == '\n') { receive(pending); pending.clear(); }
            else { require(pending.size() < maxFrame, "Process frame exceeds limit."); pending += buffer[i]; }
        }
    }
    require(pending.empty(), "Incomplete process frame.");
}

// ---------- structured host log (diagnostics; also test evidence) ----------
class Log {
    std::mutex mutex;
    fs::path file;
    size_t cap;
public:
    Log(const fs::path& path, size_t capBytes) : file(path), cap(capBytes) {
        std::error_code ignored; fs::create_directories(path.parent_path(), ignored);
    }
    void line(const std::string& text) {
        std::lock_guard lock(mutex);
        std::error_code ec;
        if (fs::exists(file, ec) && fs::file_size(file, ec) > cap) {
            auto rotated = file; rotated += L".1";
            fs::remove(rotated, ec);
            fs::rename(file, rotated, ec);
        }
        std::ofstream output(file, std::ios::binary | std::ios::app);
        output << text << '\n';
        output.flush();
    }
    void event(const std::string& name, const Json& fields = Json::object()) {
        Json entry = { { "t", std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() }, { "event", name } };
        for (auto it = fields.begin(); it != fields.end(); ++it) entry[it.key()] = it.value();
        line(entry.dump());
    }
};

// ---------- origin and path helpers ----------
// Returns "scheme://host[:port]" with the policy-origin grammar, or empty on failure.
std::string originOf(const std::wstring& wideUri) {
    std::string uri;
    try { uri = utf8(wideUri); } catch (...) { return {}; }
    auto schemeEnd = uri.find("://");
    if (schemeEnd == std::string::npos || schemeEnd == 0 || schemeEnd > 5) return {};
    std::string scheme = uri.substr(0, schemeEnd);
    for (auto& c : scheme) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (scheme != "http" && scheme != "https") return {};
    auto rest = uri.substr(schemeEnd + 3);
    auto authorityEnd = rest.find_first_of("/?#");
    auto authority = rest.substr(0, authorityEnd);
    if (authority.empty() || authority.find('@') != std::string::npos) return {};
    std::string host = authority, port;
    auto colon = authority.rfind(':');
    if (colon != std::string::npos) {
        host = authority.substr(0, colon);
        port = authority.substr(colon + 1);
        if (port.empty() || port.size() > 5) return {};
        for (char c : port) if (!std::isdigit(static_cast<unsigned char>(c))) return {};
        auto number = std::stoul(port);
        if (number == 0 || number > 65535) return {};
        if ((scheme == "https" && number == 443) || (scheme == "http" && number == 80)) port.clear();
        else port = ":" + std::to_string(number);
    }
    for (auto& c : host) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (static_cast<unsigned char>(c) > 127) return {};
    }
    static const std::regex hostPattern("^[a-z0-9]+(?:[.-][a-z0-9]+)*$");
    if (!std::regex_match(host, hostPattern)) return {};
    return scheme + "://" + host + port;
}

// ---------- policy ----------
struct StorageGrant {
    std::string scope;
    std::vector<std::string> segments;
    bool read = false, write = false;
};
struct HostPermissions {
    bool log = false;
    std::vector<StorageGrant> storage;
};
struct ViewPolicy {
    std::string id;
    std::set<std::string> origins, commands, events;
    HostPermissions host;
};

HostPermissions parseHostPermissions(const Json& value) {
    HostPermissions result;
    result.log = value["log"].get<bool>();
    for (const auto& grant : value["storage"]) {
        StorageGrant entry;
        entry.scope = grant["scope"].get<std::string>();
        std::string prefix = grant["pathPrefix"].get<std::string>();
        size_t start = 0;
        while (start <= prefix.size()) {
            auto slash = prefix.find('/', start);
            entry.segments.push_back(prefix.substr(start, slash == std::string::npos ? slash : slash - start));
            if (slash == std::string::npos) break;
            start = slash + 1;
        }
        if (entry.segments.size() == 1 && entry.segments[0].empty()) entry.segments.clear();
        for (const auto& access : grant["access"]) {
            auto name = access.get<std::string>();
            if (name == "read") entry.read = true;
            if (name == "write") entry.write = true;
        }
        result.storage.push_back(std::move(entry));
    }
    return result;
}

struct Policy {
    std::map<std::string, ViewPolicy> views;
    HostPermissions backend;
    static Policy load(const Json& schema, const fs::path& path) {
        auto value = readJson(path);
        require(valid(schema, value), "Invalid policy.");
        Policy policy;
        for (const auto& view : value["views"]) {
            ViewPolicy entry;
            entry.id = view["id"].get<std::string>();
            for (const auto& origin : view["origins"]) entry.origins.insert(origin.get<std::string>());
            for (const auto& command : view["commands"]) entry.commands.insert(command.get<std::string>());
            for (const auto& event : view["events"]) entry.events.insert(event.get<std::string>());
            entry.host = parseHostPermissions(view["host"]);
            require(policy.views.emplace(entry.id, std::move(entry)).second, "Duplicate policy view.");
        }
        policy.backend = parseHostPermissions(value["backend"]);
        return policy;
    }
};

bool storageAllowed(const HostPermissions& permissions, const std::string& scope, const std::vector<std::string>& segments, bool write) {
    for (const auto& grant : permissions.storage) {
        if (grant.scope != scope || (write ? !grant.write : !grant.read) || grant.segments.size() > segments.size()) continue;
        bool prefix = true;
        for (size_t i = 0; i < grant.segments.size(); ++i) prefix &= grant.segments[i] == segments[i];
        if (prefix) return true;
    }
    return false;
}

// ---------- scoped file boundary ----------
// The lexical JSON pattern is not the file check. This resolves the real file, pins the
// opened object, rejects reparse points/links and verifies the canonical path is inside
// the named scope root. Checks run on the opened handle so a later path swap cannot
// redirect what was already validated.
struct Scopes {
    fs::path dataRoot;      // %LOCALAPPDATA%/bunaway/<appId>
    std::wstring appDataCanonical, tempCanonical;
    fs::path appData, temp, logsDir, webData;

    fs::path root(const std::string& scope) const {
        return scope == "appData" ? appData : temp;
    }
    const std::wstring& canonical(const std::string& scope) const {
        return scope == "appData" ? appDataCanonical : tempCanonical;
    }
    static std::wstring canonicalOf(const fs::path& path) {
        Handle file(CreateFileW(path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        require(file.value != nullptr && file.value != INVALID_HANDLE_VALUE, "Scope root missing.");
        BY_HANDLE_FILE_INFORMATION info {};
        require(GetFileInformationByHandle(file.value, &info) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), "Scope root must not be a link.");
        wchar_t buffer[32768];
        DWORD n = GetFinalPathNameByHandleW(file.value, buffer, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        require(n && n < 32768, "Scope path failed.");
        return std::wstring(buffer, n);
    }
};

bool validSegment(const std::string& segment) {
    if (segment.empty() || segment == "." || segment == ".." || segment.size() > 255) return false;
    if (segment.back() == ' ' || segment.back() == '.') return false;
    for (unsigned char c : segment) {
        if (c < 0x20 || c == '<' || c == '>' || c == ':' || c == '"' || c == '|' || c == '?' || c == '*' || c == '\\') return false;
    }
    return true;
}

std::vector<std::string> splitPath(const std::string& path) {
    std::vector<std::string> segments;
    size_t start = 0;
    while (start <= path.size()) {
        auto slash = path.find('/', start);
        segments.push_back(path.substr(start, slash == std::string::npos ? slash : slash - start));
        if (slash == std::string::npos) break;
        start = slash + 1;
    }
    return segments;
}

struct HostError : std::runtime_error {
    std::string code;
    HostError(std::string c, const char* m) : std::runtime_error(m), code(std::move(c)) {}
};

// Opens the target pinned under canonicalRoot. Returns a handle the caller owns.
Handle openScopedFile(const Scopes& scopes, const std::string& scope, const std::vector<std::string>& segments, bool write) {
    const auto& rootCanonical = scopes.canonical(scope);
    std::wstring full = rootCanonical;
    for (const auto& segment : segments) {
        if (!validSegment(segment)) throw HostError("INVALID_ARGUMENT", "Invalid storage path.");
        full += L'\\';
        full += utf16(segment);
    }
    if (write) {
        // Create intermediate directories, verifying each stays inside the scope.
        std::wstring dir = rootCanonical;
        for (size_t i = 0; i + 1 < segments.size(); ++i) {
            dir += L'\\' + utf16(segments[i]);
            if (CreateDirectoryW(dir.c_str(), nullptr) || GetLastError() == ERROR_ALREADY_EXISTS) {
                BY_HANDLE_FILE_INFORMATION info {};
                Handle check(CreateFileW(dir.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
                if (!check.value || check.value == INVALID_HANDLE_VALUE) throw HostError("INTERNAL", "Storage directory failed.");
                if (!GetFileInformationByHandle(check.value, &info)) throw HostError("INTERNAL", "Storage directory check failed.");
                if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw HostError("PERMISSION_DENIED", "Storage path escapes scope.");
            } else throw HostError("INTERNAL", "Storage directory failed.");
        }
    }
    DWORD access = write ? GENERIC_WRITE : GENERIC_READ;
    DWORD disposition = write ? OPEN_ALWAYS : OPEN_EXISTING;
    Handle file(CreateFileW(full.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, disposition, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!file.value || file.value == INVALID_HANDLE_VALUE) {
        auto error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) throw HostError("INVALID_ARGUMENT", "Storage target not found.");
        throw HostError("INTERNAL", "Storage open failed.");
    }
    BY_HANDLE_FILE_INFORMATION info {};
    require(GetFileInformationByHandle(file.value, &info), "Storage stat failed.");
    if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT || info.nNumberOfLinks > 1 || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
        throw HostError("PERMISSION_DENIED", "Storage target is not a plain in-scope file.");
    }
    wchar_t buffer[32768];
    DWORD n = GetFinalPathNameByHandleW(file.value, buffer, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    require(n && n < 32768, "Storage path check failed.");
    std::wstring actual(buffer, n);
    std::wstring prefix = rootCanonical + L'\\';
    if (actual.size() <= prefix.size() || _wcsnicmp(actual.c_str(), prefix.c_str(), prefix.size()) != 0) {
        throw HostError("PERMISSION_DENIED", "Storage target is outside the named scope.");
    }
    return file;
}

std::string readStorageText(HANDLE file, size_t size) {
    std::string text(size, '\0');
    size_t offset = 0;
    while (offset < text.size()) {
        DWORD read = 0;
        require(ReadFile(file, text.data() + offset, static_cast<DWORD>(text.size() - offset), &read, nullptr), "Storage read failed.");
        require(read != 0, "Storage file changed during read.");
        offset += read;
    }
    return text;
}

// ---------- application ----------
// Owns the window, WebView2, the Bun child process and all routing state. WebView2
// callbacks run on the UI thread; backend frames arrive on the reader thread. Router
// state is always taken under stateMutex and the send queue is only appended to while
// holding it, so frame order is committed consistently.
class App {
public:
    // ---- config ----
    fs::path package, assets;
    Json manifest, processSchema, messageSchema, hostCallSchema, hostOps;
    Policy policy;
    std::string appId, viewId, home;
    int windowWidth = 1024, windowHeight = 768;
    std::wstring windowTitle;
    Scopes scopes;
    std::unique_ptr<Log> hostLog, appLog;

    // ---- Bun child process ----
    Handle job, process, input, output, stderrPipe;
    DWORD childPid = 0;
    std::mutex queueMutex;
    std::condition_variable queued;
    std::deque<std::string> queue;
    bool writerDone = false;
    std::atomic<bool> ready = false, closing = false, failed = false, exited = false, forced = false;
    std::atomic<ULONGLONG> closeTime = 0;
    std::string runtimeId, generation, backendContext;
    bool helloSeen = false;
    std::thread runtimeThread, writerThread, readerThread, stderrThread;
    std::vector<std::thread> hostWorkers;
    std::mutex workMutex;
    std::condition_variable workCv;
    std::deque<std::function<void()>> workQueue;
    bool workDone = false;

    // ---- router state ----
    struct PendingWeb { std::string kind; ULONGLONG deadlineTick; };
    struct Session {
        std::string context, viewId, source, origin;
        bool negotiated = false;
        std::map<std::string, PendingWeb> pending;
        std::set<std::string> usedIds;
        std::map<std::string, uint64_t> subscriptions;
    };
    struct HostRequest { std::string context; std::string operation; bool cancelled = false; };
    std::mutex stateMutex;
    std::map<std::string, Session> sessions;
    std::map<std::string, HostRequest> hostPending;
    std::string activeContext;
    uint64_t documentGeneration = 0;

    // ---- UI ----
    HWND hwnd = nullptr;
    ComPtr<ICoreWebView2Environment> env;
    ComPtr<ICoreWebView2> webview;
    ComPtr<ICoreWebView2Controller> controller;
    int exitCode = 1;
    std::atomic<bool> shuttingDown = false, webviewReady = false;
    HWND hwndStatic() const { return hwnd; }

    Json frame(const char* kind) const {
        return { { "kind", kind }, { "ipc", ipc }, { "runtime", { { "id", runtimeId }, { "generation", generation } } } };
    }

    // ---------- send path (any thread) ----------
    void sendLine(std::string text, bool control = false) {
        require(text.size() <= maxFrame && text.find('\n') == std::string::npos, "Outgoing frame invalid.");
        text += '\n';
        std::lock_guard lock(queueMutex);
        if (control) queue.clear();
        require(!writerDone && (control || queue.size() < maxSendQueue), "Backend send queue unavailable.");
        queue.push_back(std::move(text));
        queued.notify_one();
    }
    void send(const Json& value, bool control = false) { sendLine(value.dump(), control); }
    // Relays the already-validated raw payload so number spellings stay unchanged.
    void sendWebFrame(const std::string& context, const std::string& rawPayload) {
        sendLine("{\"kind\":\"web\",\"ipc\":{\"major\":1,\"minor\":0},\"runtime\":{\"id\":\"" + runtimeId +
            "\",\"generation\":\"" + generation + "\"},\"context\":\"" + context + "\",\"payload\":" + rawPayload + "}");
    }
    void sendControlContext(const char* kind, const std::string& context) {
        auto value = frame(kind); value["context"] = context; send(value);
    }
    void beginShutdown() {
        if (!closing.exchange(true)) {
            closeTime.store(GetTickCount64());
            try { send(frame("shutdown"), true); } catch (...) {}
        }
    }
    void runtimeFailure() {
        if (!failed.exchange(true)) {
            hostLog->event("runtime-failed");
            TerminateJobObject(job.value, 1);
            PostMessageW(hwnd, WM_APP_RUNTIME_FAILED, 0, 0);
        }
    }

    // ---------- UI helpers ----------
    struct WebDelivery {
        std::wstring text;
        std::string context;
        uint64_t documentGeneration;
    };
    // Caller holds stateMutex; preserve the destination until UI dispatch.
    void postToWeb(const std::string& context, const std::string& jsonText) {
        auto* heap = new WebDelivery{ utf16(jsonText), context, documentGeneration };
        if (!PostMessageW(hwnd, WM_APP_WEB_MESSAGE, 0, reinterpret_cast<LPARAM>(heap))) delete heap;
    }
    bool canDeliverWeb(const WebDelivery& delivery) {
        std::lock_guard lock(stateMutex);
        return !shuttingDown && delivery.documentGeneration == documentGeneration &&
            (delivery.context.empty() || (delivery.context == activeContext && sessions.count(delivery.context)));
    }
    void webError(const std::string& id, const char* code, const char* message) {
        if (id.empty()) return;
        std::lock_guard lock(stateMutex);
        postToWeb(activeContext, Json({ { "kind", "error" }, { "protocol", ipc }, { "id", id }, { "error", { { "code", code }, { "message", message } } } }).dump());
    }
    static std::string documentKey(const std::string& uri) {
        return uri.substr(0, uri.find('#'));
    }

    // ---------- WebView -> backend boundary (UI thread) ----------
    void onWebMessage(const std::wstring& sourceUri, const std::string& sourceText, const std::string& raw) {
        std::string id, reason;
        const ViewPolicy* view = &policy.views.at(viewId);
        try {
            auto message = parse(raw);
            // Recover the request id before schema validation so failures can still
            // be answered to the page; a malformed id is simply dropped. Rejected
            // payloads are never echoed to the log.
            if (message.is_object() && message.contains("id") && message["id"].is_string()) id = message["id"].get<std::string>();
            if (!message.is_object()) {
                hostLog->event("web-message-rejected", { { "reason", "malformed" }, { "source", sourceText } });
                webError(id, "INVALID_ARGUMENT", "Web message is not an object.");
                return;
            }
            if (!valid(messageSchema, message)) throw HostError("INVALID_ARGUMENT", "Rejected web message.");
            if (message["protocol"] != ipc) throw HostError("INVALID_ARGUMENT", "Protocol version mismatch.");
            auto kind = message["kind"].get<std::string>();
            if (kind != "hello" && kind != "invoke" && kind != "cancel" && kind != "listen" && kind != "unlisten") {
                throw HostError("INVALID_ARGUMENT", "Invalid web message direction.");
            }
            if (!ready) throw HostError("BUSY", "Backend is not ready.");
            std::lock_guard lock(stateMutex);
            Session* session = nullptr;
            if (activeContext.empty()) {
                if (kind != "hello") throw HostError("INVALID_ARGUMENT", "First web message must be hello.");
                auto origin = originOf(sourceUri);
                if (origin.empty() || !view->origins.count(origin)) {
                    hostLog->event("web-message-rejected", { { "reason", "origin" }, { "source", sourceText } });
                    throw HostError("PERMISSION_DENIED", "Origin is not allowed.");
                }
                session = &sessions[openSession(viewId, sourceText, origin)];
                hostLog->event("web-message", { { "context", session->context }, { "kind", "hello" } });
                sendWebFrame(session->context, raw);
                return;
            }
            session = &sessions[activeContext];
            if (documentKey(session->source) != documentKey(sourceText)) {
                hostLog->event("web-message-rejected", { { "reason", "source" }, { "source", sourceText } });
                throw HostError("PERMISSION_DENIED", "Message source does not match the session document.");
            }
            if (kind == "hello") throw HostError("INVALID_ARGUMENT", "Duplicate hello.");
            if (kind != "cancel" && !session->negotiated) throw HostError("INVALID_ARGUMENT", "Session is not negotiated.");
            if (kind == "invoke") {
                if (!view->commands.count(message["command"].get<std::string>())) {
                    hostLog->event("permission-denied", { { "kind", "command" }, { "name", message["command"].get<std::string>() }, { "view", viewId } });
                    throw HostError("PERMISSION_DENIED", "Command is not allowed for this view.");
                }
                registerRequest(*session, message, "invoke");
            } else if (kind == "listen") {
                if (!view->events.count(message["event"].get<std::string>())) {
                    hostLog->event("permission-denied", { { "kind", "event" }, { "name", message["event"].get<std::string>() }, { "view", viewId } });
                    throw HostError("PERMISSION_DENIED", "Event is not allowed for this view.");
                }
                registerRequest(*session, message, "listen");
            } else if (kind == "unlisten") {
                registerRequest(*session, message, "unlisten");
                session->subscriptions.erase(message["subscriptionId"].get<std::string>());
            } else if (kind == "cancel") {
                auto target = session->pending.find(message["id"].get<std::string>());
                if (target == session->pending.end()) { hostLog->event("web-message", { { "context", session->context }, { "kind", "cancel" }, { "id", message["id"].get<std::string>() }, { "result", "dropped" } }); return; }
            }
            hostLog->event("web-message", { { "context", session->context }, { "kind", kind }, { "id", id } });
            sendWebFrame(session->context, raw);
        } catch (const HostError& error) {
            hostLog->event("web-message-rejected", { { "reason", error.code }, { "source", sourceText } });
            webError(id, error.code.c_str(), error.what());
        } catch (...) {
            hostLog->event("web-message-rejected", { { "reason", "malformed" }, { "source", sourceText } });
        }
    }
    // Caller holds stateMutex.
    void registerRequest(Session& session, const Json& message, const std::string& kind) {
        auto id = message["id"].get<std::string>();
        if (session.usedIds.count(id)) throw HostError("INVALID_ARGUMENT", "Request ID was already used.");
        if (session.usedIds.size() >= maxRequestIds) throw HostError("BUSY", "Request ID limit reached.");
        if (session.pending.size() >= maxPendingWeb) throw HostError("BUSY", "Too many pending requests.");
        if (kind == "listen" && session.subscriptions.size() >= maxSubscriptions) throw HostError("BUSY", "Too many subscriptions.");
        ULONGLONG expiry = GetTickCount64() + maxCommandMs;
        if (kind == "invoke" && message.contains("deadline")) {
            auto epoch = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
            auto remaining = static_cast<long long>(message["deadline"].get<int64_t>() - epoch);
            if (remaining <= 0) throw HostError("TIMEOUT", "Request deadline already passed.");
            expiry = GetTickCount64() + static_cast<ULONGLONG>(std::min<long long>(remaining, maxCommandMs));
        }
        session.usedIds.insert(id);
        session.pending[id] = { kind, expiry };
    }
    // Returns the issued context. Caller holds stateMutex.
    std::string openSession(const std::string& view, const std::string& source, const std::string& origin) {
        Session session;
        session.context = "ctx-" + randomHex(12);
        session.viewId = view;
        session.source = source;
        session.origin = origin;
        auto context = session.context;
        sessions.emplace(context, std::move(session));
        activeContext = context;
        {
            auto open = frame("session-open");
            open["context"] = context;
            open["viewId"] = view;
            send(open);
        }
        hostLog->event("session-open", { { "context", context }, { "viewId", view }, { "origin", origin } });
        return context;
    }
    // Revokes the view's active session: cancels pending work and tells the backend.
    void revokeSession(const char* reason) {
        std::lock_guard lock(stateMutex);
        ++documentGeneration;
        if (activeContext.empty()) return;
        auto context = activeContext;
        activeContext.clear();
        sessions.erase(context);
        std::erase_if(hostPending, [&](const auto& item) { return item.second.context == context; });
        hostLog->event("revoke", { { "context", context }, { "reason", reason } });
        try { sendControlContext("revoke", context); } catch (...) {}
    }

    // ---------- backend -> host dispatch (reader thread) ----------
    void onBackendLine(const std::string& line) {
        auto value = parse(line);
        require(valid(processSchema, value) && value["runtime"]["id"] == runtimeId && value["runtime"]["generation"] == generation, "Invalid backend envelope.");
        auto kind = value["kind"].get<std::string>();
        if (kind == "hello") {
            require(!helloSeen && !ready && value["payload"]["protocol"] == ipc, "Protocol negotiation failed.");
            helloSeen = true;
            hostLog->event("backend-hello", { { "buildId", value["payload"]["buildId"].get<std::string>() } });
        } else if (kind == "ready") {
            require(helloSeen && !ready && value["pid"].get<uint32_t>() == childPid &&
                value["bunVersion"] == manifest["bun"]["version"] && value["revision"] == manifest["bun"]["sourceRevision"], "Unexpected runtime identity.");
            ready.store(true);
            hostLog->event("backend-ready", { { "pid", childPid }, { "bunVersion", manifest["bun"]["version"].get<std::string>() } });
        } else if (kind == "web") {
            require(ready, "Backend web frame before ready.");
            onBackendWeb(value["context"].get<std::string>(), value["payload"]);
        } else if (kind == "host-request") {
            require(ready, "Backend host request before ready.");
            onHostRequest(value);
        } else if (kind == "host-cancel") {
            onHostCancel(value["context"].get<std::string>(), value["requestId"].get<std::string>());
        } else if (kind == "stopping") {
            require(closing, "Unexpected stop.");
        } else if (kind == "fatal") {
            hostLog->event("backend-fatal", { { "message", value["error"]["message"].get<std::string>() } });
            runtimeFailure();
        } else {
            throw std::runtime_error("Invalid backend direction.");
        }
    }
    void onBackendWeb(const std::string& context, const Json& message) {
        std::lock_guard lock(stateMutex);
        auto it = sessions.find(context);
        if (it == sessions.end()) { hostLog->event("discarded", { { "reason", "inactive-context" }, { "context", context } }); return; }
        auto& session = it->second;
        auto tag = message["kind"].get<std::string>();
        if (tag == "result" || tag == "error") {
            auto id = message["id"].get<std::string>();
            auto pending = session.pending.find(id);
            if (pending == session.pending.end()) { hostLog->event("discarded", { { "reason", "late-response" }, { "context", context }, { "id", id } }); return; }
            if (tag == "result" && pending->second.kind == "listen") {
                if (!message["payload"].is_object() || message["payload"].size() != 1 || !message["payload"]["subscriptionId"].is_string()) {
                    hostLog->event("discarded", { { "reason", "invalid-subscription-result" }, { "id", id } });
                    return;
                }
                session.subscriptions[message["payload"]["subscriptionId"].get<std::string>()] = 0;
            }
            session.pending.erase(pending);
        } else if (tag == "event") {
            auto sub = session.subscriptions.find(message["subscriptionId"].get<std::string>());
            if (sub == session.subscriptions.end()) { hostLog->event("discarded", { { "reason", "inactive-subscription" }, { "context", context } }); return; }
            auto event = message["event"].get<std::string>();
            auto target = message["target"].get<std::string>();
            auto source = message["source"].get<std::string>();
            auto expected = sub->second + 1;
            if (target != session.viewId || expected != message["sequence"].get<uint64_t>() ||
                !policy.views.at(session.viewId).events.count(event) ||
                (source != "backend" && !policy.views.count(source))) {
                hostLog->event("discarded", { { "reason", "invalid-event" }, { "context", context }, { "event", event } });
                return;
            }
            sub->second = expected;
        } else if (tag == "subscription-error") {
            session.subscriptions.erase(message["subscriptionId"].get<std::string>());
        } else if (tag == "hello") {
            require(!session.negotiated, "Duplicate backend hello.");
            session.negotiated = true;
        } else {
            throw std::runtime_error("Invalid backend web direction.");
        }
        postToWeb(context, message.dump());
        hostLog->event("web-delivered", { { "context", context }, { "kind", tag }, { "id", message.contains("id") ? message["id"].get<std::string>() : "" } });
    }

    // ---------- Host operations ----------
    const HostPermissions* permissionsFor(const std::string& context) {
        if (context == backendContext) return &policy.backend;
        auto it = sessions.find(context);
        if (it == sessions.end()) return nullptr;
        return &policy.views.at(it->second.viewId).host;
    }
    void onHostRequest(const Json& value) {
        auto context = value["context"].get<std::string>();
        auto requestId = value["requestId"].get<std::string>();
        auto operation = value["operation"].get<std::string>();
        auto key = context + "|" + requestId;
        {
            std::lock_guard lock(stateMutex);
            require(hostPending.emplace(key, HostRequest{ context, operation }).second, "Duplicate host request ID.");
        }
        hostLog->event("host-request", { { "context", context }, { "requestId", requestId }, { "operation", operation } });
        {
            std::lock_guard lock(workMutex);
            require(!workDone && workQueue.size() < maxSendQueue, "Host operation queue full.");
            workQueue.push_back([this, key, context, requestId, operation, payload = value["payload"]] {
                executeHostOp(key, context, requestId, operation, payload);
            });
        }
        workCv.notify_one();
    }
    void onHostCancel(const std::string& context, const std::string& requestId) {
        std::lock_guard lock(stateMutex);
        auto it = hostPending.find(context + "|" + requestId);
        if (it == hostPending.end()) { hostLog->event("discarded", { { "reason", "late-host-cancel" }, { "requestId", requestId } }); return; }
        it->second.cancelled = true;
        hostLog->event("host-cancel", { { "requestId", requestId }, { "operation", it->second.operation } });
    }
    void hostRespond(const std::string& key, const std::string& context, const std::string& requestId, const Json& payload) {
        // Commit the response to the send queue before revoke can invalidate it.
        std::lock_guard lock(stateMutex);
        auto it = hostPending.find(key);
        if (it == hostPending.end()) return;
        if (it->second.cancelled) { hostPending.erase(it); hostLog->event("host-response-discarded", { { "requestId", requestId } }); return; }
        hostPending.erase(it);
        auto response = frame("host-response");
        response["context"] = context;
        response["requestId"] = requestId;
        response["payload"] = payload;
        send(response);
        hostLog->event("host-response", { { "requestId", requestId }, { "kind", payload["kind"].get<std::string>() } });
    }
    void executeHostOp(const std::string& key, const std::string& context, const std::string& requestId, const std::string& operation, const Json& payload) {
        Json result;
        try {
            HostPermissions permissions;
            {
                std::lock_guard lock(stateMutex);
                auto it = hostPending.find(key);
                if (it == hostPending.end()) return;
                if (it->second.cancelled) {
                    hostPending.erase(it);
                    hostLog->event("host-request-cancelled", { { "requestId", requestId } });
                    return;
                }
                const auto* current = permissionsFor(context);
                if (!current) throw HostError("PERMISSION_DENIED", "Host context is not active.");
                // This marks the operation as started. Revocation prevents queued
                // operations and discards results, but cannot roll back active I/O.
                permissions = *current;
            }
            Json call = { { "operation", operation }, { "payload", payload } };
            if (!valid(hostCallSchema, call)) throw HostError("INVALID_ARGUMENT", "Invalid host request.");
            if (operation == "capabilities.get") {
                result = Json::array({
                    { { "name", "storage.readText" }, { "support", "supported" }, { "permission", "not-required" } },
                    { { "name", "storage.writeText" }, { "support", "supported" }, { "permission", "not-required" } },
                    { { "name", "log.write" }, { "support", "supported" }, { "permission", "not-required" } },
                    { { "name", "capabilities.get" }, { "support", "supported" }, { "permission", "not-required" } },
                });
            } else if (operation == "log.write") {
                if (!permissions.log) throw HostError("PERMISSION_DENIED", "Logging is not allowed for this context.");
                Json entry = {
                    { "t", std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() },
                    { "level", payload["level"].get<std::string>() },
                    { "source", context == backendContext ? "backend" : "view:" + viewId },
                    { "message", payload["message"].get<std::string>() },
                };
                if (payload.contains("details")) entry["details"] = payload["details"];
                appLog->line(entry.dump());
                result = nullptr;
            } else {
                auto scope = payload["scope"].get<std::string>();
                auto segments = splitPath(payload["path"].get<std::string>());
                bool write = operation == "storage.writeText";
                if (!storageAllowed(permissions, scope, segments, write)) {
                    hostLog->event("host-request-denied", { { "operation", operation }, { "scope", scope }, { "path", payload["path"].get<std::string>() } });
                    throw HostError("PERMISSION_DENIED", "Storage scope is not allowed for this context.");
                }
                Handle file = openScopedFile(scopes, scope, segments, write);
                if (write) {
                    auto text = payload["text"].get_ref<const std::string&>();
                    size_t offset = 0;
                    while (offset < text.size()) {
                        DWORD written = 0;
                        require(WriteFile(file.value, text.data() + offset, static_cast<DWORD>(std::min<size_t>(text.size() - offset, 1 << 20)), &written, nullptr), "Storage write failed.");
                        offset += written;
                    }
                    require(SetEndOfFile(file.value), "Storage truncate failed.");
                    result = nullptr;
                } else {
                    LARGE_INTEGER size;
                    require(GetFileSizeEx(file.value, &size), "Storage size failed.");
                    require(size.QuadPart <= static_cast<LONGLONG>(maxFileBytes), "Storage file too large.");
                    result = readStorageText(file.value, static_cast<size_t>(size.QuadPart));
                }
            }
            if (!valid(hostOps.at(operation)["output"], result)) throw HostError("INTERNAL", "Host operation produced an invalid result.");
            hostRespond(key, context, requestId, { { "kind", "result" }, { "payload", result } });
        } catch (const HostError& error) {
            hostRespond(key, context, requestId, { { "kind", "error" }, { "error", { { "code", error.code }, { "message", error.what() } } } });
        } catch (...) {
            hostRespond(key, context, requestId, { { "kind", "error" }, { "error", { { "code", "INTERNAL" }, { "message", "Host operation failed." } } } });
        }
    }

    // ---------- request deadlines (UI timer) ----------
    void scanDeadlines() {
        std::vector<std::pair<std::string, std::string>> expired;
        {
            std::lock_guard lock(stateMutex);
            auto now = GetTickCount64();
            for (auto& [context, session] : sessions) {
                for (auto it = session.pending.begin(); it != session.pending.end();) {
                    if (now >= it->second.deadlineTick) { expired.emplace_back(context, it->first); it = session.pending.erase(it); }
                    else ++it;
                }
            }
            for (const auto& [context, id] : expired) {
                try {
                    sendWebFrame(context, Json({ { "kind", "cancel" }, { "protocol", ipc }, { "id", id } }).dump());
                } catch (...) {}
            }
        }
        for (const auto& [context, id] : expired) {
            hostLog->event("request-timeout", { { "context", context }, { "id", id } });
            webError(id, "TIMEOUT", "Request deadline exceeded.");
        }
    }

    // ---------- Bun child process lifecycle (runtime thread) ----------
    void runtimeMain(const fs::path& bunPath) {
        try {
            SECURITY_ATTRIBUTES sa { sizeof sa, nullptr, TRUE };
            HANDLE childIn, hostIn, childOut, hostOut, childErr, hostErr;
            require(CreatePipe(&childIn, &hostIn, &sa, 0), "stdin pipe failed.");
            Handle childInput(childIn); input.reset(hostIn);
            require(CreatePipe(&hostOut, &childOut, &sa, 0), "stdout pipe failed.");
            Handle childOutput(childOut); output.reset(hostOut);
            require(CreatePipe(&hostErr, &childErr, &sa, 0), "stderr pipe failed.");
            Handle childError(childErr); stderrPipe.reset(hostErr);
            for (auto h : { input.value, output.value, stderrPipe.value }) require(SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0), "Pipe inheritance failed.");
            STARTUPINFOEXW startup {}; startup.StartupInfo.cb = sizeof startup;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = childIn; startup.StartupInfo.hStdOutput = childOut; startup.StartupInfo.hStdError = childErr;
            SIZE_T attributeSize = 0;
            InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
            std::vector<char> attributeBuffer(attributeSize);
            startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBuffer.data());
            require(InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeSize), "Handle list initialization failed.");
            struct AttributesGuard { LPPROC_THREAD_ATTRIBUTE_LIST p; ~AttributesGuard() { DeleteProcThreadAttributeList(p); } } attributeGuard { startup.lpAttributeList };
            HANDLE inherited[] = { childIn, childOut, childErr };
            require(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof inherited, nullptr, nullptr), "Handle list failed.");
            wchar_t windows[MAX_PATH]; require(GetWindowsDirectoryW(windows, MAX_PATH), "System directory failed.");
            std::map<std::wstring, std::wstring> childEnv = {
                { L"BUN_RUNTIME_TRANSPILER_CACHE_PATH", L"0" }, { L"DO_NOT_TRACK", L"1" },
                { L"HOME", scopes.dataRoot.wstring() }, { L"NO_COLOR", L"1" },
                { L"PATH", fs::path(windows).wstring() + L"\\System32" },
                { L"SystemRoot", windows }, { L"TEMP", scopes.temp.wstring() }, { L"TMP", scopes.temp.wstring() },
                { L"USERPROFILE", scopes.dataRoot.wstring() }
            };
            std::vector<wchar_t> block;
            for (const auto& [key, val] : childEnv) { auto entry = key + L"=" + val; block.insert(block.end(), entry.begin(), entry.end()); block.push_back(0); }
            block.push_back(0);
            std::wstring command = quote(bunPath.wstring()) + L" --no-env-file --no-install " +
                quote(L"--config=" + (assets / "bunfig.toml").wstring()) + L" " +
                quote(L"--tsconfig-override=" + (assets / "tsconfig.json").wstring()) + L" " +
                quote((assets / "backend.js").wstring());
            PROCESS_INFORMATION info {};
            require(CreateProcessW(bunPath.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, block.data(), assets.c_str(), &startup.StartupInfo, &info), "Bun process creation failed.");
            process.reset(info.hProcess); Handle thread(info.hThread); childPid = info.dwProcessId;
            if (!AssignProcessToJobObject(job.value, process.value)) { TerminateProcess(process.value, 1); WaitForSingleObject(process.value, 5000); throw std::runtime_error("Job assignment failed."); }
            hostLog->event("host-started", { { "hostPid", GetCurrentProcessId() }, { "childPid", childPid }, { "bunPath", utf8(bunPath.wstring()) }, { "runtime", { { "id", runtimeId }, { "generation", generation } } } });
            require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "Bun resume failed.");
            childInput.reset(); childOutput.reset(); childError.reset();

            writerThread = std::thread([&] {
                try {
                    for (;;) {
                        std::string next;
                        { std::unique_lock lock(queueMutex); queued.wait(lock, [&] { return writerDone || !queue.empty(); }); if (writerDone) break; next = std::move(queue.front()); queue.pop_front(); }
                        writeAll(input.value, next);
                    }
                } catch (...) { if (!exited) runtimeFailure(); }
            });
            readerThread = std::thread([&] {
                try {
                    readLines(output.value, [&](const std::string& line) { onBackendLine(line); });
                    if (!closing) runtimeFailure();
                } catch (...) { if (!exited) runtimeFailure(); }
            });
            stderrThread = std::thread([&] {
                Log backendLog(scopes.logsDir / "backend.log", 1024 * 1024);
                char data[8192]; DWORD n = 0;
                while (ReadFile(stderrPipe.value, data, sizeof data, &n, nullptr) && n) {
                    backendLog.line(std::string(data, n));
                }
            });
            for (size_t i = 0; i < 2; ++i) {
                hostWorkers.emplace_back([&] {
                    for (;;) {
                        std::function<void()> task;
                        {
                            std::unique_lock lock(workMutex);
                            workCv.wait(lock, [&] { return workDone || !workQueue.empty(); });
                            if (workDone) return;
                            task = std::move(workQueue.front()); workQueue.pop_front();
                        }
                        task();
                    }
                });
            }
            auto boot = frame("boot");
            boot["payload"] = {
                { "entrypoint", utf8((assets / "backend.js").wstring()) },
                { "buildId", appId + "-host" },
                { "policy", readJson(assets / "policy.json") },
                { "backendContext", backendContext }
            };
            send(boot);
            auto hello = frame("hello");
            hello["payload"] = { { "kind", "hello" }, { "protocol", ipc }, { "features", Json::array() }, { "buildId", appId + "-host" } };
            send(hello);

            ULONGLONG started = GetTickCount64();
            while (WaitForSingleObject(process.value, 10) == WAIT_TIMEOUT) {
                if ((!ready && GetTickCount64() - started > readyDeadlineMs) ||
                    (closing && closeTime.load() && GetTickCount64() - closeTime.load() > shutdownDeadlineMs)) {
                    forced.store(true); TerminateJobObject(job.value, 1);
                }
            }
            exited.store(true);
            TerminateJobObject(job.value, 1);
            { std::lock_guard lock(queueMutex); writerDone = true; queued.notify_one(); }
            writerThread.join();
            readerThread.join();
            stderrThread.join();
            { std::lock_guard lock(workMutex); workDone = true; }
            workCv.notify_all();
            for (auto& worker : hostWorkers) worker.join();

            DWORD code = 1;
            GetExitCodeProcess(process.value, &code);
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting {};
            ULONGLONG deadline = GetTickCount64() + 5000;
            do {
                QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, nullptr);
                if (!accounting.ActiveProcesses) break;
                Sleep(10);
            } while (GetTickCount64() < deadline);
            if (accounting.ActiveProcesses) failed.store(true);
            if (!closing && !failed.load()) failed.store(true);
            {
                std::lock_guard lock(stateMutex);
                for (auto& [context, session] : sessions) {
                    for (const auto& [id, pending] : session.pending) {
                        postToWeb(context, Json({ { "kind", "error" }, { "protocol", ipc }, { "id", id }, { "error", { { "code", "INTERNAL" }, { "message", "Backend connection closed." } } } }).dump());
                    }
                }
                sessions.clear();
                activeContext.clear();
            }
            hostLog->event("host-stopped", { { "exitCode", code }, { "forced", forced.load() }, { "failed", failed.load() }, { "activeProcesses", accounting.ActiveProcesses }, { "childPid", childPid } });
            PostMessageW(hwnd, WM_APP_RUNTIME_EXITED, 0, 0);
        } catch (...) {
            failed.store(true);
            exited.store(true);
            try { hostLog->event("host-fatal", { { "message", "Runtime startup failed." } }); } catch (...) {}
            TerminateJobObject(job.value, 1);
            { std::lock_guard lock(queueMutex); writerDone = true; queued.notify_one(); }
            { std::lock_guard lock(workMutex); workDone = true; }
            workCv.notify_all();
            // Pipes break once the job is dead, so the I/O threads can be joined here.
            if (writerThread.joinable()) writerThread.join();
            if (readerThread.joinable()) readerThread.join();
            if (stderrThread.joinable()) stderrThread.join();
            for (auto& worker : hostWorkers) if (worker.joinable()) worker.join();
            PostMessageW(hwnd, WM_APP_RUNTIME_EXITED, 0, 0);
        }
    }

    // ---------- WebView2 (UI thread) ----------
    void initWebView() {
        auto udf = (scopes.webData).wstring();
        HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.c_str(), nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [this](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
                    if (FAILED(result) || !environment) { hostLog->event("webview2-init-failed", { { "hr", static_cast<int64_t>(result) } }); runtimeFailure(); return S_OK; }
                    env = environment;
                    env->CreateCoreWebView2Controller(hwnd,
                        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [this](HRESULT result, ICoreWebView2Controller* created) -> HRESULT {
                                if (FAILED(result) || !created) { hostLog->event("webview2-init-failed", { { "hr", static_cast<int64_t>(result) } }); runtimeFailure(); return S_OK; }
                                controller = created;
                                controller->get_CoreWebView2(&webview);
                                RECT bounds; GetClientRect(hwnd, &bounds);
                                controller->put_Bounds(bounds);
                                controller->put_IsVisible(TRUE);
                                configureWebView();
                                webview->Navigate(utf16(home).c_str());
                                webviewReady.store(true);
                                hostLog->event("webview-ready");
                                return S_OK;
                            }).Get());
                    return S_OK;
                }).Get());
        require(SUCCEEDED(hr), "WebView2 environment creation failed.");
    }
    void configureWebView() {
        ComPtr<ICoreWebView2Settings> settings;
        webview->get_Settings(&settings);
        settings->put_IsWebMessageEnabled(TRUE);
        settings->put_AreDefaultScriptDialogsEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        settings->put_AreDevToolsEnabled(FALSE);
        ComPtr<ICoreWebView2Settings3> settings3;
        if (SUCCEEDED(settings.As(&settings3)) && settings3) {
            settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
        }
        ComPtr<ICoreWebView2Settings4> settings4;
        if (SUCCEEDED(settings.As(&settings4)) && settings4) {
            settings4->put_IsGeneralAutofillEnabled(FALSE);
            settings4->put_IsPasswordAutosaveEnabled(FALSE);
        }
        auto hostPart = home.substr(home.find("://") + 3);
        hostPart = hostPart.substr(0, hostPart.find_first_of("/:&#"));
        auto virtualHost = utf16(hostPart);
        ComPtr<ICoreWebView2_3> webview3;
        require(SUCCEEDED(webview.As(&webview3)) && webview3, "WebView2 virtual host mapping unsupported.");
        require(SUCCEEDED(webview3->SetVirtualHostNameToFolderMapping(virtualHost.c_str(), (assets / "web").wstring().c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS)), "Virtual host mapping failed.");
        webview->AddWebResourceRequestedFilter(L"http://*/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        webview->AddWebResourceRequestedFilter(L"https://*/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        webview->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                LPWSTR uri = nullptr;
                args->get_Uri(&uri);
                std::wstring target = uri ? uri : L"";
                CoTaskMemFree(uri);
                auto origin = originOf(target);
                if (origin.empty() || !policy.views.at(viewId).origins.count(origin)) {
                    args->put_Cancel(TRUE);
                    hostLog->event("navigation-blocked", { { "uri", utf8(target) } });
                } else {
                    // The committed document is replaced, so the old session and
                    // its pending requests are revoked before it can be reused.
                    revokeSession("navigation");
                    hostLog->event("navigation", { { "uri", utf8(target) } });
                }
                return S_OK;
            }).Get(), nullptr);
        webview->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                BOOL success = FALSE;
                args->get_IsSuccess(&success);
                COREWEBVIEW2_WEB_ERROR_STATUS status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                args->get_WebErrorStatus(&status);
                LPWSTR uri = nullptr;
                webview->get_Source(&uri);
                hostLog->event("navigation-completed", { { "success", success == TRUE }, { "webErrorStatus", static_cast<int64_t>(status) }, { "source", uri ? utf8(uri) : "" } });
                CoTaskMemFree(uri);
                return S_OK;
            }).Get(), nullptr);
        webview->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                LPWSTR source = nullptr, json = nullptr;
                args->get_Source(&source);
                args->get_WebMessageAsJson(&json);
                std::wstring sourceCopy = source ? source : L"";
                std::string sourceText, raw;
                try { sourceText = utf8(sourceCopy); raw = utf8(json ? json : L""); } catch (...) {}
                CoTaskMemFree(source); CoTaskMemFree(json);
                onWebMessage(sourceCopy, sourceText, raw);
                return S_OK;
            }).Get(), nullptr);
        webview->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                LPWSTR uri = nullptr;
                args->get_Uri(&uri);
                hostLog->event("new-window-blocked", { { "uri", uri ? utf8(uri) : "" } });
                CoTaskMemFree(uri);
                args->put_Handled(TRUE);
                return S_OK;
            }).Get(), nullptr);
        webview->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_PERMISSION_KIND permissionKind;
                args->get_PermissionKind(&permissionKind);
                hostLog->event("permission-request-denied", { { "kind", static_cast<int64_t>(permissionKind) } });
                ComPtr<ICoreWebView2PermissionRequestedEventArgs3> args3;
                if (SUCCEEDED(args->QueryInterface(IID_PPV_ARGS(args3.ReleaseAndGetAddressOf()))) && args3) args3->put_SavesInProfile(FALSE);
                args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                return S_OK;
            }).Get(), nullptr);
        webview->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_PROCESS_FAILED_KIND failedKind;
                args->get_ProcessFailedKind(&failedKind);
                hostLog->event("webview-process-failed", { { "kind", static_cast<int64_t>(failedKind) } });
                revokeSession("process-failed");
                if (failedKind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) {
                    shuttingDown.store(true);
                    beginShutdown();
                } else if (!shuttingDown) {
                    webview->Navigate(utf16(home).c_str());
                }
                return S_OK;
            }).Get(), nullptr);
        webview->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                ComPtr<ICoreWebView2WebResourceRequest> request;
                args->get_Request(&request);
                LPWSTR uri = nullptr;
                request->get_Uri(&uri);
                std::wstring target = uri ? uri : L"";
                auto origin = originOf(target);
                CoTaskMemFree(uri);
                if (origin.empty() || !policy.views.at(viewId).origins.count(origin)) {
                    ComPtr<ICoreWebView2WebResourceResponse> response;
                    if (env && SUCCEEDED(env->CreateWebResourceResponse(nullptr, 403, L"Forbidden", L"Content-Type: text/plain", &response))) {
                        args->put_Response(response.Get());
                    }
                    hostLog->event("web-resource-blocked", { { "uri", utf8(target) } });
                }
                return S_OK;
            }).Get(), nullptr);
    }

    // ---------- shutdown ----------
    void beginClose(int code) {
        if (shuttingDown.exchange(true)) return;
        exitCode = code;
        if (webview) revokeSession("closing");
        beginShutdown();
        hostLog->event("closing");
    }
    void stopWorkers() {
        std::lock_guard lock(workMutex);
        workDone = true;
        workCv.notify_all();
    }
};

static App* g_app = nullptr;

LRESULT CALLBACK wndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* app = g_app;
    switch (message) {
    case WM_SIZE:
        if (app && app->controller) {
            RECT bounds; GetClientRect(hwnd, &bounds);
            app->controller->put_Bounds(bounds);
        }
        return 0;
    case WM_TIMER:
        if (app) app->scanDeadlines();
        return 0;
    case WM_APP_WEB_MESSAGE: {
        auto* delivery = reinterpret_cast<App::WebDelivery*>(lParam);
        if (app && app->webview && app->canDeliverWeb(*delivery)) {
            app->webview->PostWebMessageAsJson(delivery->text.c_str());
        }
        delete delivery;
        return 0;
    }
    case WM_APP_RUNTIME_FAILED:
        if (app) app->beginClose(1);
        return 0;
    case WM_APP_RUNTIME_EXITED:
        if (app) {
            if (app->controller) app->controller->Close();
            DestroyWindow(hwnd);
        }
        return 0;
    case WM_CLOSE:
        if (app) {
            app->beginClose(0);
            return 0;
        }
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

static void windowSet(App& app, const Json& config) {
    app.windowTitle = utf16(config.value("title", std::string("bunaway app")));
    if (config.contains("window")) {
        app.windowWidth = config["window"].value("width", 1024);
        app.windowHeight = config["window"].value("height", 768);
    }
}

int run(const fs::path& package) {
    App app;
    g_app = &app;
    app.package = package;
    app.assets = package / "assets";
    app.processSchema = readJson(app.assets / "process.schema.json");
    app.messageSchema = readJson(app.assets / "message.schema.json");
    app.hostCallSchema = readJson(app.assets / "host-call.schema.json");
    app.hostOps = readJson(app.assets / "host-operations.json");
    app.manifest = readJson(package / "manifest.json");
    auto config = readJson(app.assets / "app.json");
    static const std::regex appIdPattern("^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$");
    app.appId = config.value("appId", "");
    require(std::regex_match(app.appId, appIdPattern), "Invalid appId.");
    app.viewId = config.value("view", "");
    app.home = config.value("home", "");
    windowSet(app, config);

    app.policy = Policy::load(readJson(app.assets / "policy.schema.json"), app.assets / "policy.json");
    require(app.policy.views.count(app.viewId), "Configured view is not in the policy.");
    auto homeOrigin = originOf(utf16(app.home));
    require(!homeOrigin.empty() && app.policy.views.at(app.viewId).origins.count(homeOrigin), "Home origin is not an allowed origin.");

    const fs::path bun = package / "runtime/bun.exe";
    require(sha256(bun) == app.manifest["bun"]["executableSha256"].get<std::string>(), "Bun executable hash mismatch.");
    for (auto it = app.manifest["assets"].begin(); it != app.manifest["assets"].end(); ++it) {
        require(sha256(app.package / fs::path(std::u8string(it.key().begin(), it.key().end()))) == it.value().get<std::string>(), "Package asset hash mismatch.");
    }

    wchar_t* localAppData = nullptr;
    require(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData) == S_OK && localAppData, "App data directory failed.");
    app.scopes.dataRoot = fs::path(localAppData) / "bunaway" / utf16(app.appId);
    CoTaskMemFree(localAppData);
    app.scopes.appData = app.scopes.dataRoot / "data";
    app.scopes.temp = app.scopes.dataRoot / "temp";
    app.scopes.logsDir = app.scopes.dataRoot / "logs";
    app.scopes.webData = app.scopes.dataRoot / "webview";
    fs::create_directories(app.scopes.appData);
    fs::create_directories(app.scopes.temp);
    fs::create_directories(app.scopes.logsDir);
    app.scopes.appDataCanonical = Scopes::canonicalOf(app.scopes.appData);
    app.scopes.tempCanonical = Scopes::canonicalOf(app.scopes.temp);
    app.hostLog = std::make_unique<Log>(app.scopes.logsDir / "host.log", 1024 * 1024);
    app.appLog = std::make_unique<Log>(app.scopes.logsDir / "app.log", 1024 * 1024);

    app.runtimeId = app.appId;
    app.generation = randomHex(16);
    app.backendContext = "backend-" + randomHex(12);
    app.hostLog->event("host-init", { { "appId", app.appId }, { "runtime", { { "id", app.runtimeId }, { "generation", app.generation } } } });

    HANDLE rawJob = CreateJobObjectW(nullptr, nullptr);
    require(rawJob != nullptr, "Job creation failed.");
    app.job.reset(rawJob);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(app.job.value, JobObjectExtendedLimitInformation, &limits, sizeof limits), "Job limits failed.");

    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    WNDCLASSEXW wc {};
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = wndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    wc.lpszClassName = L"bunaway-host";
    require(RegisterClassExW(&wc), "Window class failed.");
    DWORD style = WS_OVERLAPPEDWINDOW;
    RECT rect { 0, 0, app.windowWidth, app.windowHeight };
    AdjustWindowRect(&rect, style, FALSE);
    app.hwnd = CreateWindowExW(0, wc.lpszClassName, app.windowTitle.c_str(), style,
        CW_USEDEFAULT, CW_USEDEFAULT, rect.right - rect.left, rect.bottom - rect.top,
        nullptr, nullptr, wc.hInstance, nullptr);
    require(app.hwnd != nullptr, "Window creation failed.");
    SetTimer(app.hwnd, 1, 250, nullptr);
    ShowWindow(app.hwnd, SW_SHOW);
    UpdateWindow(app.hwnd);

    app.runtimeThread = std::thread([&app, bun] { app.runtimeMain(bun); });
    try {
        app.initWebView();
    } catch (...) {
        app.beginClose(1);
        if (app.runtimeThread.joinable()) app.runtimeThread.join();
        throw;
    }

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    app.beginClose(app.exitCode);
    if (app.runtimeThread.joinable()) app.runtimeThread.join();
    app.stopWorkers();
    for (auto& worker : app.hostWorkers) if (worker.joinable()) worker.join();
    g_app = nullptr;
    return app.exitCode;
}

int wmain(int argc, wchar_t** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
    try {
        if (argc > 2 && std::wstring(argv[1]) == L"--watch") {
            std::vector<HANDLE> watched;
            for (int i = 2; i < argc; ++i) {
                auto handle = OpenProcess(SYNCHRONIZE, FALSE, std::stoul(argv[i]));
                require(handle != nullptr, "Watch process missing.");
                watched.push_back(handle);
            }
            require(watched.size() <= MAXIMUM_WAIT_OBJECTS, "Too many watched processes.");
            writeAll(GetStdHandle(STD_OUTPUT_HANDLE), "watch-ready\n");
            auto result = WaitForMultipleObjects(static_cast<DWORD>(watched.size()), watched.data(), TRUE, 15000);
            for (auto handle : watched) CloseHandle(handle);
            return result == WAIT_OBJECT_0 ? 0 : 1;
        }
        if (argc == 2 && std::wstring(argv[1]) == L"--validate") {
            readLines(GetStdHandle(STD_INPUT_HANDLE), [](const std::string& line) {
                bool accepted = false;
                try { auto input = parse(line); accepted = valid(input.at("schema"), input.at("value")); } catch (...) {}
                writeAll(GetStdHandle(STD_OUTPUT_HANDLE), accepted ? "true\n" : "false\n");
            });
            return 0;
        }
        wchar_t location[32768]; DWORD n = GetModuleFileNameW(nullptr, location, 32768);
        require(n && n < 32768, "Host path failed.");
        return run(fs::path(location).parent_path());
    } catch (const std::exception& error) {
        std::string message = std::string("Host startup failed: ") + error.what() + "\n";
        writeAll(GetStdHandle(STD_ERROR_HANDLE), message);
        return 1;
    } catch (...) {
        std::cerr << "Host startup failed.\n";
        return 1;
    }
}
