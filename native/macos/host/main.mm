// macOS product host — AppKit/WKWebView and POSIX bundled-process host.
//
// Platform mapping (the only semantic deltas, all inside the adapter boundary):
//  - Win32 window/WebView2 -> NSApplication + NSWindow + WKWebView.
//  - WebView2 virtual host https://app.bunaway.local cannot be reproduced:
//    WKURLSchemeHandler cannot serve the https scheme. Assets are served under
//    the custom scheme bunaway:// and the adapter normalizes origins
//    bunaway://H -> https://H before policy comparison, so the shared
//    policy/schema contract stays byte-identical (protocol.md: normalization
//    is the native adapter's job; the first contract grammar is http(s)-only).
//  - WebResourceRequested (per-subresource interception) has no WKWebView
//    equivalent. Frame navigations still get policy-checked via the navigation
//    delegate (blocked subframes log web-resource-blocked); non-frame
//    subresources are enforced silently by a compiled WKContentRuleList.
//  - Job Object -> Bun child in its own process group + `--guard` watchdog
//    (same binary, death-pipe EOF -> SIGKILL the group). Residual race is the
//    microsecond spawn window; documented.
//  - Renderer death -> -webViewWebContentProcessDidTerminate -> revoke +
//    reload home (Windows ProcessFailed -> Navigate(home)).
//  - Same-document URL changes (History API) are not delegated by WebKit, so
//    the session source is updated lazily at message time when the observed
//    origin still matches (a real navigation revokes the session first).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <spawn.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <signal.h>
#include <sys/poll.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <vector>
#include <cstdio>
#include "json.hpp"

static void dispatch_main(std::function<void()> block);

using Json = nlohmann::json;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

constexpr size_t maxFrame = 1'048'576;
constexpr int maxDepth = 64;
constexpr size_t maxSendQueue = 128;
constexpr size_t maxPendingWeb = 128;
constexpr size_t maxRequestIds = 1024;
constexpr size_t maxSubscriptions = 128;
constexpr size_t maxFileBytes = 4 * 1024 * 1024;
constexpr int64_t readyDeadlineMs = 10'000;
constexpr int64_t shutdownDeadlineMs = 2'000;
constexpr int64_t maxCommandMs = 30'000;
const Json ipc = { { "major", 1 }, { "minor", 0 } };

struct Fd {
    int value = -1;
    Fd() = default;
    explicit Fd(int fd) : value(fd) {}
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    Fd(Fd&& other) noexcept : value(other.value) { other.value = -1; }
    Fd& operator=(Fd&& other) noexcept { reset(other.value); other.value = -1; return *this; }
    ~Fd() { reset(); }
    void reset(int fd = -1) { if (value >= 0) close(value); value = fd; }
};

void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

std::string utf8(NSString* value) {
    return value ? std::string(value.UTF8String) : std::string();
}
NSString* nsstr(const std::string& value) {
    return [NSString stringWithUTF8String:value.c_str()];
}
NSString* nsstr(const char* value) {
    return [NSString stringWithUTF8String:value];
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

// Same JSON Schema subset as the Windows host and the B probe.
size_t unicodeSize(const std::string& value) {
    size_t count = 0;
    for (unsigned char byte : value) if ((byte & 0xc0) != 0x80) ++count;
    return count;
}

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

// Minimal SHA-256 (FIPS 180-4) — no crypto dependency, same as the probe.
namespace {
struct Sha256 {
    uint32_t state[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
    uint64_t length = 0;
    uint8_t block[64] = {};
    size_t buffered = 0;
    static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
    void transform(const uint8_t* data) {
        static const uint32_t k[64] = {
            0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
            0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
            0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
            0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
            0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
        };
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) w[i] = (uint32_t(data[i*4]) << 24) | (uint32_t(data[i*4+1]) << 16) | (uint32_t(data[i*4+2]) << 8) | uint32_t(data[i*4+3]);
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >> 3);
            uint32_t s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = h + s1 + ch + k[i] + w[i];
            uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = s0 + maj;
            h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e; state[5] += f; state[6] += g; state[7] += h;
    }
    void update(const uint8_t* data, size_t size) {
        length += size;
        while (size) {
            size_t take = std::min(size, 64 - buffered);
            std::memcpy(block + buffered, data, take);
            buffered += take; data += take; size -= take;
            if (buffered == 64) { transform(block); buffered = 0; }
        }
    }
    void finish(uint8_t digest[32]) {
        uint64_t bits = length * 8;
        uint8_t pad = 0x80;
        update(&pad, 1);
        uint8_t zero = 0;
        while (buffered != 56) { update(&zero, 1); }
        for (int i = 7; i >= 0; --i) { uint8_t byte = (bits >> (i * 8)) & 0xff; update(&byte, 1); }
        for (int i = 0; i < 8; ++i) {
            digest[i*4] = (state[i] >> 24) & 0xff; digest[i*4+1] = (state[i] >> 16) & 0xff;
            digest[i*4+2] = (state[i] >> 8) & 0xff; digest[i*4+3] = state[i] & 0xff;
        }
    }
};
}

std::string sha256(const fs::path& path) {
    std::ifstream input(path, std::ios::binary);
    require(input.good(), "Hash asset missing.");
    Sha256 hash;
    char buffer[65536];
    while (input.read(buffer, sizeof buffer) || input.gcount()) hash.update(reinterpret_cast<uint8_t*>(buffer), static_cast<size_t>(input.gcount()));
    require(input.eof(), "Hash read failed.");
    uint8_t digest[32];
    hash.finish(digest);
    std::string result;
    for (uint8_t byte : digest) { result += "0123456789abcdef"[byte >> 4]; result += "0123456789abcdef"[byte & 15]; }
    return result;
}

std::string randomHex(size_t bytes) {
    std::vector<uint8_t> raw(bytes);
    arc4random_buf(raw.data(), raw.size());
    std::string result;
    for (uint8_t byte : raw) { result += "0123456789abcdef"[byte >> 4]; result += "0123456789abcdef"[byte & 15]; }
    return result;
}

int64_t monoMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
}
int64_t epochMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// pipe(2) with FD_CLOEXEC on both ends so the Bun child never inherits the
// death-pipe write end (the watchdog must see EOF on host death).
void makePipe(int fds[2]) {
    require(pipe(fds) == 0, "Pipe failed.");
    for (int i = 0; i < 2; ++i) require(fcntl(fds[i], F_SETFD, FD_CLOEXEC) == 0, "Pipe flags failed.");
}

void writeAll(int fd, const std::string& text) {
    size_t offset = 0;
    while (offset < text.size()) {
        ssize_t written = write(fd, text.data() + offset, text.size() - offset);
        require(written > 0, "Pipe write failed.");
        offset += static_cast<size_t>(written);
    }
}

template<typename F> void readLines(int fd, F receive) {
    std::string pending;
    char buffer[8192];
    for (;;) {
        ssize_t length = read(fd, buffer, sizeof buffer);
        if (length < 0) { require(errno == EINTR || errno == EAGAIN, "Pipe read failed."); continue; }
        if (!length) break;
        for (ssize_t i = 0; i < length; ++i) {
            if (buffer[i] == '\n') { receive(pending); pending.clear(); }
            else { require(pending.size() < maxFrame, "Process frame exceeds limit."); pending += buffer[i]; }
        }
    }
    require(pending.empty(), "Incomplete process frame.");
}

// kill(pid,0) reports zombies as alive; treat SZOMB (5) as dead so group
// accounting does not wait on corpses launchd has not reaped.
bool processAlive(pid_t pid) {
    if (kill(pid, 0) != 0) return errno == EPERM;
    struct proc_bsdinfo info {};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) == sizeof info && info.pbi_status == 5) return false; // SZOMB
    return true;
}
// JobObjectBasicAccountingInformation analog: live members of the group.
int groupSize(pid_t pgid) {
    pid_t pids[1024];
    int bytes = proc_listpids(PROC_PGRP_ONLY, static_cast<uint32_t>(pgid), pids, sizeof pids);
    int count = 0;
    if (bytes > 0) for (int i = 0; i < bytes / static_cast<int>(sizeof(pid_t)); ++i) if (processAlive(pids[i])) ++count;
    return count;
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
            auto rotated = file; rotated += ".1";
            fs::remove(rotated, ec);
            fs::rename(file, rotated, ec);
        }
        std::ofstream output(file, std::ios::binary | std::ios::app);
        output << text << '\n';
        output.flush();
    }
    void event(const std::string& name, const Json& fields = Json::object()) {
        Json entry = { { "t", epochMs() }, { "event", name } };
        for (auto it = fields.begin(); it != fields.end(); ++it) entry[it.key()] = it.value();
        line(entry.dump());
    }
};

// ---------- origin helpers ----------
// Returns the declared-form origin "scheme://host[:port]" — https:// for both
// real https origins and bunaway:// platform origins (adapter normalization).
std::string originOf(const std::string& uri) {
    auto schemeEnd = uri.find("://");
    if (schemeEnd == std::string::npos || schemeEnd == 0 || schemeEnd > 8) return {};
    std::string scheme = uri.substr(0, schemeEnd);
    for (auto& c : scheme) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (scheme == "bunaway") scheme = "https"; // platform asset scheme -> declared https origin
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

// Declared https://H asset URL -> the URL the webview actually loads.
std::string platformUrl(const std::string& uri) {
    auto origin = originOf(uri);
    if ((origin == "https://app.bunaway.local" || origin.rfind("https://app.bunaway.local:", 0) == 0) && uri.rfind("https://", 0) == 0)
        return "bunaway://" + uri.substr(8);
    return uri;
}

std::string developmentUrl(const std::string& uri) {
    NSURL* url = [NSURL URLWithString:nsstr(uri)];
    auto origin = originOf(uri);
    auto host = utf8(url.host);
    auto scheme = utf8(url.scheme);
    require(url && (scheme == "http" || scheme == "https") && !origin.empty() && (host == "localhost" || host == "127.0.0.1") &&
        !url.user && !url.password && !url.fragment, "Development URL must be a loopback HTTP(S) URL.");
    return uri;
}

Json resourceRules(const std::set<std::string>& origins) {
    Json rules = Json::array({ {
        { "trigger", { { "url-filter", "^https?://" } } },
        { "action", { { "type", "block" } } }
    } });
    for (const auto& declared : origins) {
        auto origin = originOf(declared);
        require(!origin.empty(), "Invalid resource origin.");
        std::string filter = "^";
        for (char c : origin) {
            if (c == '.') filter += '\\';
            filter += c;
        }
        auto authority = origin.substr(origin.find("://") + 3);
        if (authority.find(':') == std::string::npos)
            filter += origin.rfind("https://", 0) == 0 ? "(:443)?" : "(:80)?";
        // WebKit does not support regex alternation: keep the two URL endings separate.
        for (const auto& ending : { "[/?#]", "$" }) {
            rules.push_back({
                { "trigger", { { "url-filter", filter + ending } } },
                { "action", { { "type", "ignore-previous-rules" } } }
            });
        }
    }
    return rules;
}

// ---------- policy (identical shape to the Windows host) ----------
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
// POSIX port of openScopedFile: lexical checks first, then the real file is
// opened with O_NOFOLLOW on every component, root and parents stay pinned via
// dirfd, and the final fd's kernel path (F_GETPATH) must stay under the
// canonical scope root. Symlinks/junction equivalents fail with ELOOP.
struct Scopes {
    fs::path dataRoot;
    std::string appDataCanonical, tempCanonical;
    fs::path appData, temp, logsDir, webData;

    fs::path root(const std::string& scope) const {
        return scope == "appData" ? appData : temp;
    }
    const std::string& canonical(const std::string& scope) const {
        return scope == "appData" ? appDataCanonical : tempCanonical;
    }
    static std::string canonicalOf(const fs::path& path) {
        int fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        require(fd >= 0, "Scope root missing or not a directory.");
        struct stat st {};
        bool ok = fstat(fd, &st) == 0 && S_ISDIR(st.st_mode);
        if (ok) {
            char buffer[PATH_MAX];
            ok = fcntl(fd, F_GETPATH, buffer) == 0;
            close(fd);
            if (!ok) throw std::runtime_error("Scope path failed.");
            return std::string(buffer);
        }
        close(fd);
        throw std::runtime_error("Scope root must not be a link.");
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

// Opens the target pinned under the scope root. Caller owns the returned fd.
Fd openScopedFile(const Scopes& scopes, const std::string& scope, const std::vector<std::string>& segments, bool write) {
    const auto& rootCanonical = scopes.canonical(scope);
    for (const auto& segment : segments) {
        if (!validSegment(segment)) throw HostError("INVALID_ARGUMENT", "Invalid storage path.");
    }
    std::vector<Fd> parents;
    Fd root(open(scopes.root(scope).c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
    if (root.value < 0) throw HostError("INTERNAL", "Storage root open failed.");
    parents.push_back(std::move(root));
    for (size_t i = 0; i + 1 < segments.size(); ++i) {
        if (write) {
            if (mkdirat(parents.back().value, segments[i].c_str(), 0770) != 0 && errno != EEXIST)
                throw HostError("INTERNAL", "Storage directory failed.");
        }
        int next = openat(parents.back().value, segments[i].c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (next < 0) {
            // macOS reports ENOTDIR (not ELOOP) for O_NOFOLLOW+O_DIRECTORY on a
            // symlink: re-check with fstatat to keep the junction denial
            // semantics of the Windows host (PERMISSION_DENIED, not not-found).
            int error = errno;
            struct stat lst {};
            bool exists = fstatat(parents.back().value, segments[i].c_str(), &lst, AT_SYMLINK_NOFOLLOW) == 0;
            if (error == ELOOP || (exists && !S_ISDIR(lst.st_mode)))
                throw HostError("PERMISSION_DENIED", "Storage path is not a plain directory.");
            if (!exists || error == ENOENT || error == ENOTDIR)
                throw HostError("INVALID_ARGUMENT", "Storage target not found.");
            throw HostError("INTERNAL", "Storage directory failed.");
        }
        struct stat st {};
        if (fstat(next, &st) != 0 || !S_ISDIR(st.st_mode)) { close(next); throw HostError("PERMISSION_DENIED", "Storage path is not a plain directory."); }
        parents.push_back(Fd(next));
    }
    int flags = (write ? (O_WRONLY | O_CREAT) : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK;
    Fd file(segments.empty() ? -1 : openat(parents.back().value, segments.back().c_str(), flags, 0660));
    if (file.value < 0) {
        if (errno == ENOENT || errno == ENOTDIR) throw HostError("INVALID_ARGUMENT", "Storage target not found.");
        if (errno == ELOOP || errno == ENXIO) throw HostError("PERMISSION_DENIED", "Storage target is not a plain in-scope file.");
        throw HostError("INTERNAL", "Storage open failed.");
    }
    struct stat st {};
    if (fstat(file.value, &st) != 0) throw HostError("INTERNAL", "Storage stat failed.");
    if (S_ISLNK(st.st_mode) || S_ISDIR(st.st_mode) || !S_ISREG(st.st_mode) || st.st_nlink > 1)
        throw HostError("PERMISSION_DENIED", "Storage target is not a plain in-scope file.");
    char buffer[PATH_MAX];
    if (fcntl(file.value, F_GETPATH, buffer) != 0) throw HostError("INTERNAL", "Storage path check failed.");
    std::string actual(buffer);
    std::string prefix = rootCanonical + "/";
    if (actual.size() <= prefix.size() || actual.compare(0, prefix.size(), prefix) != 0)
        throw HostError("PERMISSION_DENIED", "Storage target is outside the named scope.");
    return file;
}

std::string readStorageText(int file, size_t size) {
    std::string text(size, '\0');
    size_t offset = 0;
    while (offset < text.size()) {
        ssize_t n = read(file, text.data() + offset, text.size() - offset);
        require(n > 0, "Storage read failed.");
        offset += static_cast<size_t>(n);
    }
    return text;
}

// ---------- application ----------
// Same ownership model as the Windows host: the UI runloop (main queue) owns
// the webview and window; backend frames arrive on the reader thread; router
// state commits under stateMutex.
class App {
public:
    // ---- config ----
    fs::path package, assets;
    Json manifest, processSchema, messageSchema, hostCallSchema, hostOps;
    Policy policy;
    std::string appId, viewId, home;
    int windowWidth = 1024, windowHeight = 768;
    std::string windowTitle;
    Scopes scopes;
    std::unique_ptr<Log> hostLog, appLog;

    // ---- Bun child process ----
    pid_t childPid = 0, guardPid = 0;
    Fd input, output, stderrPipe, deathWrite;
    std::mutex queueMutex;
    std::condition_variable queued;
    std::deque<std::string> queue;
    bool writerDone = false;
    std::atomic<bool> ready = false, closing = false, failed = false, exited = false, forced = false;
    std::atomic<int64_t> closeTime = 0;
    std::atomic<int> childStatus = 0;
    std::string runtimeId, generation, backendContext;
    bool helloSeen = false;
    std::thread runtimeThread, writerThread, readerThread, stderrThread;
    std::vector<std::thread> hostWorkers;
    std::mutex workMutex;
    std::condition_variable workCv;
    std::deque<std::function<void()>> workQueue;
    bool workDone = false;
    // Test hook: BUNAWAY_HOST_OP_DELAY_MS delays every host operation on its
    // worker before the pending check, so a cancel deterministically arrives
    // first (the cancel-first path is otherwise a microsecond race on POSIX).
    int hostOpDelayMs = 0;

    // ---- router state ----
    struct PendingWeb { std::string kind; int64_t deadlineTick; };
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
    // Bumped under stateMutex by revokeSession; read lock-free by postToWeb,
    // which may already run under the caller's stateMutex hold.
    std::atomic<uint64_t> documentGeneration = 0;

    // ---- UI (main queue only) ----
    NSWindow* window = nullptr;
    WKWebView* webview = nullptr;
    int exitCode = 1;
    std::atomic<bool> shuttingDown = false, webviewReady = false;

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
    std::string encodeWebFrame(const std::string& context, const std::string& rawPayload) {
        auto text = "{\"kind\":\"web\",\"ipc\":{\"major\":1,\"minor\":0},\"runtime\":{\"id\":\"" + runtimeId +
            "\",\"generation\":\"" + generation + "\"},\"context\":\"" + context + "\",\"payload\":" + rawPayload + "}";
        try { parse(text); }
        catch (...) { throw HostError("INVALID_ARGUMENT", "Web message exceeds internal IPC limits."); }
        return text;
    }
    void sendWebFrame(const std::string& context, const std::string& rawPayload) {
        sendLine(encodeWebFrame(context, rawPayload));
    }
    void sendControlContext(const char* kind, const std::string& context) {
        auto value = frame(kind); value["context"] = context; send(value);
    }
    void beginShutdown() {
        if (!closing.exchange(true)) {
            closeTime.store(monoMs());
            try { send(frame("shutdown"), true); } catch (...) {}
        }
    }
    void runtimeFailure() {
        if (!failed.exchange(true)) {
            hostLog->event("runtime-failed");
            if (childPid > 0) killpg(childPid, SIGKILL);
            dispatch_main([this] { this->beginClose(1); });
        }
    }

    // ---------- UI helpers ----------
    // PostWebMessageAsJson analog: deliver a JSON message to the page. The
    // injected shim defines window.chrome.webview plus __bunawayDeliver which
    // re-dispatches the parsed payload to page listeners.
    void postToWeb(const std::string& context, const std::string& jsonText) {
        if (failed || shuttingDown) return;
        uint64_t gen = documentGeneration.load();
        std::string script = "__bunawayDeliver(" + Json(jsonText).dump() + ")";
        dispatch_main([this, context, gen, script = std::move(script)] {
            std::lock_guard lock(stateMutex);
            if (failed || shuttingDown || gen != documentGeneration.load() ||
                (!context.empty() && (context != activeContext || !sessions.count(context)))) return;
            if (webview) [webview evaluateJavaScript:nsstr(script) completionHandler:nil];
        });
    }
    void webError(const std::string& id, const char* code, const char* message) {
        if (id.empty()) return;
        postToWeb(activeContext, Json({ { "kind", "error" }, { "protocol", ipc }, { "id", id }, { "error", { { "code", code }, { "message", message } } } }).dump());
    }
    static std::string documentKey(const std::string& uri) {
        return uri.substr(0, uri.find('#'));
    }

    // ---------- WebView -> backend boundary (main queue) ----------
    void onWebMessage(const std::string& sourceText, const std::string& raw) {
        std::string id, reason;
        const ViewPolicy* view = &policy.views.at(viewId);
        try {
            auto message = parse(raw);
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
                auto origin = originOf(sourceText);
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
                // WebKit has no same-document SourceChanged event: a source that
                // changed without a navigation (which would have revoked) is a
                // History API change if the origin still matches.
                if (originOf(sourceText) == session->origin) session->source = sourceText;
                else {
                    hostLog->event("web-message-rejected", { { "reason", "source" }, { "source", sourceText } });
                    throw HostError("PERMISSION_DENIED", "Message source does not match the session document.");
                }
            }
            if (kind == "hello") throw HostError("INVALID_ARGUMENT", "Duplicate hello.");
            if (kind != "cancel" && !session->negotiated) throw HostError("INVALID_ARGUMENT", "Session is not negotiated.");
            auto outgoing = encodeWebFrame(session->context, raw);
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
            sendLine(std::move(outgoing));
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
        int64_t expiry = monoMs() + maxCommandMs;
        if (kind == "invoke" && message.contains("deadline")) {
            auto remaining = static_cast<long long>(message["deadline"].get<int64_t>() - epochMs());
            if (remaining <= 0) throw HostError("TIMEOUT", "Request deadline already passed.");
            expiry = monoMs() + static_cast<int64_t>(std::min<long long>(remaining, maxCommandMs));
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
        documentGeneration.fetch_add(1);
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
            require(helloSeen && !ready && value["pid"].get<uint32_t>() == static_cast<uint32_t>(childPid) &&
                value["bunVersion"] == manifest["bun"]["version"] && value["revision"] == manifest["bun"]["sourceRevision"], "Unexpected runtime identity.");
            ready.store(true);
            hostLog->event("backend-ready", { { "pid", childPid }, { "bunVersion", manifest["bun"]["version"].get<std::string>() } });
            dispatch_main([this] { this->navigateWhenReady(); });
        } else if (kind == "web") {
            require(ready, "Backend web frame before ready.");
            onBackendWeb(value["context"].get<std::string>(), value["payload"]);
        } else if (kind == "host-request") {
            require(helloSeen && !closing, "Backend host request outside active runtime.");
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
        {
            std::lock_guard lock(stateMutex);
            auto it = sessions.find(context);
            if (it == sessions.end()) { hostLog->event("discarded", { { "reason", "inactive-context" }, { "context", context } }); return; }
            auto& session = it->second;
            auto tag = message["kind"].get<std::string>();
            if (tag == "result" || tag == "error") {
                auto id = message["id"].get<std::string>();
                auto pending = session.pending.find(id);
                if (pending == session.pending.end()) { hostLog->event("discarded", { { "reason", "late-response" }, { "context", context }, { "id", id } }); return; }
                if (monoMs() >= pending->second.deadlineTick) {
                    session.pending.erase(pending);
                    notifyTimeout(context, id);
                    return;
                }
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
                if (session.negotiated) throw std::runtime_error("Duplicate backend hello.");
                session.negotiated = true;
            } else {
                throw std::runtime_error("Invalid backend web direction.");
            }
        }
        postToWeb(context, message.dump());
        hostLog->event("web-delivered", { { "context", context }, { "kind", message["kind"].get<std::string>() }, { "id", message.contains("id") ? message["id"].get<std::string>() : "" } });
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
        std::lock_guard lock(stateMutex);
        auto it = hostPending.find(key);
        if (it == hostPending.end()) return;
        if (it->second.cancelled) { hostPending.erase(it); hostLog->event("host-response-discarded", { { "requestId", requestId } }); return; }
        auto response = frame("host-response");
        response["context"] = context;
        response["requestId"] = requestId;
        response["payload"] = payload;
        auto text = response.dump();
        if (text.size() > maxFrame) {
            response["payload"] = { { "kind", "error" }, { "error", { { "code", "INTERNAL" }, { "message", "Host response exceeds IPC frame limit." } } } };
            text = response.dump();
        }
        try { sendLine(std::move(text)); }
        catch (...) { hostPending.erase(it); runtimeFailure(); return; }
        hostPending.erase(it);
        hostLog->event("host-response", { { "requestId", requestId }, { "kind", response["payload"]["kind"].get<std::string>() } });
    }
    void executeHostOp(const std::string& key, const std::string& context, const std::string& requestId, const std::string& operation, const Json& payload) {
        if (hostOpDelayMs > 0) std::this_thread::sleep_for(std::chrono::milliseconds(hostOpDelayMs));
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
                for (auto it = hostOps.begin(); it != hostOps.end(); ++it) {
                    if (it.key().rfind("windows.", 0) == 0)
                        result.push_back({ { "name", it.key() }, { "support", "unsupported" }, { "permission", "not-required" } });
                }
            } else if (operation.rfind("windows.", 0) == 0) {
                throw HostError("UNSUPPORTED", "Window operations currently require Windows.");
            } else if (operation == "log.write") {
                if (!permissions.log) throw HostError("PERMISSION_DENIED", "Logging is not allowed for this context.");
                Json entry = {
                    { "t", epochMs() },
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
                Fd file = openScopedFile(scopes, scope, segments, write);
                if (write) {
                    auto text = payload["text"].get_ref<const std::string&>();
                    size_t offset = 0;
                    while (offset < text.size()) {
                        ssize_t written = ::write(file.value, text.data() + offset, std::min<size_t>(text.size() - offset, 1 << 20));
                        require(written > 0, "Storage write failed.");
                        offset += static_cast<size_t>(written);
                    }
                    require(ftruncate(file.value, static_cast<off_t>(text.size())) == 0, "Storage truncate failed.");
                    result = nullptr;
                } else {
                    struct stat st {};
                    require(fstat(file.value, &st) == 0, "Storage size failed.");
                    require(st.st_size <= static_cast<off_t>(maxFileBytes), "Storage file too large.");
                    result = readStorageText(file.value, static_cast<size_t>(st.st_size));
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
    void notifyTimeout(const std::string& context, const std::string& id) {
        try {
            sendWebFrame(context, Json({ { "kind", "cancel" }, { "protocol", ipc }, { "id", id } }).dump());
        } catch (...) {}
        postToWeb(context, Json({ { "kind", "error" }, { "protocol", ipc }, { "id", id },
            { "error", { { "code", "TIMEOUT" }, { "message", "Request deadline exceeded." } } } }).dump());
        hostLog->event("request-timeout", { { "context", context }, { "id", id } });
    }
    void scanDeadlines() {
        std::vector<std::pair<std::string, std::string>> expired;
        {
            std::lock_guard lock(stateMutex);
            auto now = monoMs();
            for (auto& [context, session] : sessions) {
                for (auto it = session.pending.begin(); it != session.pending.end();) {
                    if (now >= it->second.deadlineTick) { expired.emplace_back(context, it->first); it = session.pending.erase(it); }
                    else ++it;
                }
            }
            for (const auto& [context, id] : expired) notifyTimeout(context, id);
        }
    }

    // ---------- Bun child process lifecycle (runtime thread) ----------
    void verifyBun(const fs::path& bun) const {
        const auto& runtime = manifest.at("bun");
        const auto& expected = runtime.contains("packagedSha256")
            ? runtime.at("packagedSha256") : runtime.at("executableSha256");
        require(sha256(bun) == expected.get<std::string>(), "Bun executable hash mismatch.");
    }
    void spawnBun(const fs::path& bun) {
        verifyBun(bun);
        int inPipe[2], outPipe[2], errPipe[2], deathPipe[2];
        makePipe(inPipe); makePipe(outPipe); makePipe(errPipe); makePipe(deathPipe);
        input.reset(inPipe[1]); output.reset(outPipe[0]); stderrPipe.reset(errPipe[0]); deathWrite.reset(deathPipe[1]);
        auto entry = (assets / "backend.js").string();
        auto config = std::string("--config=") + (assets / "bunfig.toml").string();
        auto tsconfig = std::string("--tsconfig-override=") + (assets / "tsconfig.json").string();
        std::vector<std::string> argStore = {
            bun.string(), "--no-env-file", "--no-install", config, tsconfig, entry
        };
        std::vector<char*> argv;
        for (auto& arg : argStore) argv.push_back(arg.data());
        argv.push_back(nullptr);
        std::vector<std::string> envStore = {
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "DO_NOT_TRACK=1",
            "HOME=" + scopes.dataRoot.string(), "NO_COLOR=1", "PATH=/usr/bin:/bin",
            "TMPDIR=" + scopes.temp.string()
        };
        std::vector<char*> envp;
        for (auto& env : envStore) envp.push_back(env.data());
        envp.push_back(nullptr);
        posix_spawn_file_actions_t actions;
        posix_spawn_file_actions_init(&actions);
        require(posix_spawn_file_actions_adddup2(&actions, inPipe[0], 0) == 0, "stdin dup2 failed.");
        require(posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1) == 0, "stdout dup2 failed.");
        require(posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2) == 0, "stderr dup2 failed.");
        require(posix_spawn_file_actions_addchdir_np(&actions, assets.c_str()) == 0, "cwd failed.");
        posix_spawnattr_t attr;
        posix_spawnattr_init(&attr);
        require(posix_spawnattr_setpgroup(&attr, 0) == 0, "Spawn group failed.");
        require(posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP) == 0, "Spawn flags failed.");
        int error = posix_spawn(&childPid, bun.c_str(), &actions, &attr, argv.data(), envp.data());
        posix_spawn_file_actions_destroy(&actions);
        posix_spawnattr_destroy(&attr);
        close(inPipe[0]); close(outPipe[1]); close(errPipe[1]);
        require(error == 0, "Bun process creation failed.");
        {
            auto self = executablePath();
            std::vector<std::string> guardArgs = { self.string(), "--guard", std::to_string(childPid) };
            std::vector<char*> gargv;
            for (auto& g : guardArgs) gargv.push_back(g.data());
            gargv.push_back(nullptr);
            std::vector<std::string> guardEnv = { "PATH=/usr/bin:/bin" };
            std::vector<char*> genv;
            for (auto& e : guardEnv) genv.push_back(e.data());
            genv.push_back(nullptr);
            posix_spawn_file_actions_t gactions;
            posix_spawn_file_actions_init(&gactions);
            posix_spawn_file_actions_addopen(&gactions, 0, "/dev/null", O_RDONLY, 0);
            posix_spawn_file_actions_addopen(&gactions, 1, "/dev/null", O_WRONLY, 0);
            posix_spawn_file_actions_addopen(&gactions, 2, "/dev/null", O_WRONLY, 0);
            posix_spawn_file_actions_adddup2(&gactions, deathPipe[0], 3);
            posix_spawn_file_actions_addclose(&gactions, deathPipe[0]);
            int gerror = posix_spawn(&guardPid, self.c_str(), &gactions, nullptr, gargv.data(), genv.data());
            posix_spawn_file_actions_destroy(&gactions);
            close(deathPipe[0]);
            if (gerror != 0) { killpg(childPid, SIGKILL); waitpid(childPid, nullptr, 0); throw std::runtime_error("Guard spawn failed."); }
        }
        hostLog->event("host-started", { { "hostPid", getpid() }, { "childPid", childPid }, { "guardPid", guardPid }, { "bunPath", bun.string() }, { "runtime", { { "id", runtimeId }, { "generation", generation } } } });
    }

    void runtimeMain(const fs::path& bun) {
        try {
            spawnBun(bun);
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
                char data[8192]; ssize_t n = 0;
                while ((n = read(stderrPipe.value, data, sizeof data)) > 0) {
                    backendLog.line(std::string(data, static_cast<size_t>(n)));
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
                { "entrypoint", (assets / "backend.js").string() },
                { "buildId", appId + "-host" },
                { "policy", readJson(assets / "policy.json") },
                { "backendContext", backendContext }
            };
            send(boot);
            auto hello = frame("hello");
            hello["payload"] = { { "kind", "hello" }, { "protocol", ipc }, { "features", Json::array() }, { "buildId", appId + "-host" } };
            send(hello);

            int64_t started = monoMs();
            int status = 0;
            while (waitpid(childPid, &status, WNOHANG) == 0) {
                int64_t now = monoMs();
                if ((!ready && now - started > readyDeadlineMs) ||
                    (closing && closeTime.load() && now - closeTime.load() > shutdownDeadlineMs)) {
                    forced.store(true); killpg(childPid, SIGKILL);
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            exited.store(true);
            childStatus.store(status);
            killpg(childPid, SIGKILL); // sweep descendants still in the group
            { std::lock_guard lock(queueMutex); writerDone = true; queued.notify_one(); }
            writerThread.join();
            readerThread.join();
            stderrThread.join();
            { std::lock_guard lock(workMutex); workDone = true; }
            workCv.notify_all();
            for (auto& worker : hostWorkers) worker.join();

            int code = 1;
            if (WIFEXITED(status)) code = WEXITSTATUS(status);
            else if (WIFSIGNALED(status)) code = 128 + WTERMSIG(status);
            int remaining = -1;
            auto deadline = Clock::now() + std::chrono::seconds(5);
            do {
                remaining = groupSize(childPid);
                if (!remaining) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            } while (Clock::now() < deadline);
            if (remaining) failed.store(true);
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
            hostLog->event("host-stopped", { { "exitCode", code }, { "forced", forced.load() }, { "failed", failed.load() }, { "activeProcesses", remaining }, { "childPid", childPid } });
            dispatch_main([this] { this->onRuntimeExited(); });
        } catch (...) {
            failed.store(true);
            exited.store(true);
            try { hostLog->event("host-fatal", { { "message", "Runtime startup failed." } }); } catch (...) {}
            if (childPid > 0) killpg(childPid, SIGKILL);
            { std::lock_guard lock(queueMutex); writerDone = true; queued.notify_one(); }
            { std::lock_guard lock(workMutex); workDone = true; }
            workCv.notify_all();
            if (writerThread.joinable()) writerThread.join();
            if (readerThread.joinable()) readerThread.join();
            if (stderrThread.joinable()) stderrThread.join();
            for (auto& worker : hostWorkers) if (worker.joinable()) worker.join();
            dispatch_main([this] { this->onRuntimeExited(); });
        }
    }

    // ---------- WKWebView (main queue) ----------
    bool initialNavigationStarted = false;
    void navigateWhenReady() {
        if (ready && webviewReady && webview && !closing && !failed && !initialNavigationStarted) {
            initialNavigationStarted = true;
            NSURL* url = [NSURL URLWithString:nsstr(platformUrl(home))];
            if (!url || ![webview loadRequest:[NSURLRequest requestWithURL:url]]) runtimeFailure();
        }
    }
    void onRuntimeExited() {
        if (failed) exitCode = 1;
        if (window) [window close];
        [NSApp terminate:nil];
    }
    void tick() {
        // Timer-driven fallback: delivery and failure paths must not depend on
        // queued dispatch blocks surviving a saturated or torn-down UI.
        if (failed) beginClose(1);
        else { navigateWhenReady(); scanDeadlines(); }
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

    static fs::path executablePath() {
        uint32_t size = 0;
        _NSGetExecutablePath(nullptr, &size);
        std::vector<char> buffer(size);
        require(_NSGetExecutablePath(buffer.data(), &size) == 0, "Host path failed.");
        return fs::weakly_canonical(fs::path(buffer.data()));
    }
};

static App* g_app = nullptr;
// Dispatch onto the main queue. WKWebView and NSApplication objects are
// main-runloop-only, the same boundary the Windows host's message queue sets.
static void dispatch_main(std::function<void()> block) {
    auto* heap = new std::function<void()>(std::move(block));
    dispatch_async_f(dispatch_get_main_queue(), heap, [](void* raw) {
        auto* task = static_cast<std::function<void()>*>(raw);
        (*task)();
        delete task;
    });
}

// ---------- ObjC delegates ----------
// Bridge shim: window.chrome.webview shape over webkit.messageHandlers so the
// unchanged cross-platform test assets run; __bunawayDeliver carries
// host -> page messages with the same JSON.parse semantics as WebView2.
static NSString* kBridgeShim =
    @"(function(){"
    "if (window.chrome && window.chrome.webview) return;"
    "var listeners = new Set();"
    "window.chrome = { webview: {"
    "  postMessage: function(m){ window.webkit.messageHandlers.bunaway.postMessage(m); },"
    "  addEventListener: function(t, cb){ if (t === 'message') listeners.add(cb); },"
    "  removeEventListener: function(t, cb){ if (t === 'message') listeners.delete(cb); }"
    "}};"
    "window.__bunawayDeliver = function(text){"
    "  var data; try { data = JSON.parse(text); } catch (e) { return; }"
    "  Array.from(listeners).forEach(function(cb){ try { cb({ data: data }); } catch (e) {} });"
    "};"
    "})();";

@interface BWSchemeHandler : NSObject <WKURLSchemeHandler>
@end
@implementation BWSchemeHandler
- (instancetype)init {
    return [super init];
}
- (void)webView:(WKWebView*)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    @autoreleasepool {
        App* app = g_app;
        NSURL* url = task.request.URL;
        // Validate the real authority before normalizing the host-owned asset scheme.
        std::string origin;
        if (url && [url.scheme caseInsensitiveCompare:@"bunaway"] == NSOrderedSame && !url.user && !url.password)
            origin = originOf(utf8(url.absoluteString));
        bool allowed = app && !origin.empty() && app->policy.views.count(app->viewId) &&
            app->policy.views.at(app->viewId).origins.count(origin);
        fs::path file;
        std::string mime = "application/octet-stream";
        if (allowed) {
            std::string rel = utf8(url.path ? [url.path stringByRemovingPercentEncoding] : @"");
            if (rel.empty() || rel == "/") rel = "/index.html";
            auto segments = splitPath(rel.substr(1));
            bool safe = true;
            for (auto& s : segments) if (!validSegment(s)) safe = false;
            if (safe) {
                file = app->assets / "web";
                for (auto& s : segments) file /= s;
                std::error_code ec;
                auto canonical = fs::weakly_canonical(file, ec);
                auto root = fs::weakly_canonical(app->assets / "web", ec);
                if (ec || canonical.string().rfind(root.string() + "/", 0) != 0) safe = false;
                else file = canonical;
            }
            if (safe) {
                auto ext = file.extension().string();
                if (ext == ".html") mime = "text/html";
                else if (ext == ".js" || ext == ".mjs") mime = "text/javascript";
                else if (ext == ".css") mime = "text/css";
                else if (ext == ".json") mime = "application/json";
                else if (ext == ".png") mime = "image/png";
                else if (ext == ".svg") mime = "image/svg+xml";
                std::ifstream input(file, std::ios::binary | std::ios::ate);
                if (input.good()) {
                    auto size = input.tellg();
                    input.seekg(0);
                    std::string body(static_cast<size_t>(size), '\0');
                    input.read(body.data(), size);
                    NSHTTPURLResponse* response = [[NSHTTPURLResponse alloc]
                        initWithURL:url statusCode:200 HTTPVersion:@"HTTP/1.1"
                        headerFields:@{ @"Content-Type": nsstr(mime),
                                        @"Content-Length": nsstr(std::to_string(body.size())) }];
                    [task didReceiveResponse:response];
                    [task didReceiveData:[NSData dataWithBytes:body.data() length:body.size()]];
                    [task didFinish];
                    return;
                }
            }
        }
        NSHTTPURLResponse* denied = [[NSHTTPURLResponse alloc]
            initWithURL:url statusCode:403 HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type": @"text/plain"}];
        [task didReceiveResponse:denied];
        [task didFinish];
    }
}
- (void)webView:(WKWebView*)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
}
@end

@interface BWNavDelegate : NSObject <WKNavigationDelegate>
@end
@implementation BWNavDelegate
- (void)webView:(WKWebView*)webView decidePolicyForNavigationAction:(WKNavigationAction*)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    App* app = g_app;
    if (!app) { decisionHandler(WKNavigationActionPolicyCancel); return; }
    std::string target = utf8(action.request.URL.absoluteString);
    if (!action.targetFrame) {
        // New-window request: WKWebView already calls createWebViewWithConfiguration;
        // a nil targetFrame here is a window.open/target=_blank -> block.
        app->hostLog->event("new-window-blocked", { { "uri", target } });
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    auto origin = originOf(target);
    const ViewPolicy& view = app->policy.views.at(app->viewId);
    if (!action.targetFrame.isMainFrame) {
        // Subframe navigation: allowed origins pass, anything else is blocked.
        // Both hosts report blocked subframe navigation as web-resource-blocked.
        if (origin.empty() || !view.origins.count(origin)) {
            app->hostLog->event("web-resource-blocked", { { "uri", target } });
            decisionHandler(WKNavigationActionPolicyCancel);
            return;
        }
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (origin.empty() || !view.origins.count(origin)) {
        app->hostLog->event("navigation-blocked", { { "uri", target } });
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    // The committed document is replaced: revoke the old session first.
    app->revokeSession("navigation");
    app->hostLog->event("navigation", { { "uri", target } });
    decisionHandler(WKNavigationActionPolicyAllow);
}
- (void)webView:(WKWebView*)webView didFinishNavigation:(WKNavigation*)navigation {
    App* app = g_app;
    if (!app) return;
    app->hostLog->event("navigation-completed", { { "success", true }, { "webErrorStatus", 0 }, { "source", utf8(webView.URL.absoluteString) } });
}
- (void)webView:(WKWebView*)webView didFailProvisionalNavigation:(WKNavigation*)navigation withError:(NSError*)error {
    App* app = g_app;
    if (!app) return;
    app->hostLog->event("navigation-completed", { { "success", false }, { "webErrorStatus", static_cast<int64_t>(error.code) }, { "source", utf8(webView.URL.absoluteString) } });
}
- (void)webView:(WKWebView*)webView didFailNavigation:(WKNavigation*)navigation withError:(NSError*)error {
    App* app = g_app;
    if (!app) return;
    app->hostLog->event("navigation-completed", { { "success", false }, { "webErrorStatus", static_cast<int64_t>(error.code) }, { "source", utf8(webView.URL.absoluteString) } });
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView*)webView {
    App* app = g_app;
    if (!app) return;
    app->hostLog->event("webview-process-failed", { { "kind", 1 } });
    app->revokeSession("process-failed");
    if (!app->shuttingDown) {
        app->initialNavigationStarted = true; // recovery navigates home directly
        NSURL* url = [NSURL URLWithString:nsstr(platformUrl(app->home))];
        [webView loadRequest:[NSURLRequest requestWithURL:url]];
    }
}
- (void)webView:(WKWebView*)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin*)origin initiatedByFrame:(WKFrameInfo*)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))decisionHandler {
    App* app = g_app;
    if (app) app->hostLog->event("permission-request-denied", { { "kind", static_cast<int64_t>(type) } });
    decisionHandler(WKPermissionDecisionDeny);
}
- (void)webView:(WKWebView*)webView navigationAction:(WKNavigationAction*)navigationAction didBecomeDownload:(WKDownload*)download {
    [download cancel:^(NSData* resumeData) {}];
}
@end

@interface BWScriptHandler : NSObject <WKScriptMessageHandler>
@end
@implementation BWScriptHandler
- (void)userContentController:(WKUserContentController*)controller didReceiveScriptMessage:(WKScriptMessage*)message {
    App* app = g_app;
    if (!app) return;
    if (!message.frameInfo.isMainFrame) {
        // Frame-level channel: WebView2 never forwards subframe messages to the
        // host; WKWebView delivers them with frameInfo, so drop non-main frames.
        app->hostLog->event("frame-message-ignored", { { "source", utf8(message.frameInfo.request.URL.absoluteString) } });
        return;
    }
    // Use the live document URL as the source: it reflects History API changes,
    // matching WebView2's Source semantics.
    std::string source = utf8(message.webView.URL.absoluteString);
    id body = message.body;
    std::string raw;
    @try {
        if ([body isKindOfClass:[NSString class]]) {
            raw = Json(utf8((NSString*)body)).dump();
        } else if (body == [NSNull null] || body == nil) {
            raw = "null";
        } else {
            NSData* data = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
            raw = data ? std::string((const char*)data.bytes, data.length) : "";
        }
    } @catch (...) {
        raw = "";
    }
    app->onWebMessage(source, raw);
}
@end

@interface BWWindowDelegate : NSObject <NSWindowDelegate>
@end
@implementation BWWindowDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender {
    App* app = g_app;
    if (app) app->beginClose(0);
    return YES;
}
@end

@interface BWAppDelegate : NSObject <NSApplicationDelegate>
@end
@implementation BWAppDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
    App* app = g_app;
    if (!app || app->exited) return NSTerminateNow;
    // Backend still running: close gracefully, onRuntimeExited re-terminates.
    app->beginClose(0);
    return NSTerminateCancel;
}
- (void)applicationWillTerminate:(NSNotification*)note {
}
@end

@interface BWTickTarget : NSObject
@end
@implementation BWTickTarget
- (void)tick:(NSTimer*)timer {
    if (g_app) g_app->tick();
}
@end

static int run(const fs::path& package, const std::string& devUrl = "") {
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
    if (config.contains("development") || !devUrl.empty()) {
        require(config.contains("development") && config["development"].is_object() &&
            config["development"].size() == 1 && config["development"].value("url", "") == devUrl &&
            !devUrl.empty(), "Development URL requires a matching development artifact and --dev-url launch flag.");
        developmentUrl(devUrl);
        require(config.value("home", "") == devUrl, "Development home does not match --dev-url.");
    }
    static const std::regex appIdPattern("^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$");
    app.appId = config.value("appId", "");
    require(std::regex_match(app.appId, appIdPattern), "Invalid appId.");
    app.viewId = config.value("view", "");
    app.home = config.value("home", "");
    app.windowTitle = config.value("title", std::string("bunaway app"));
    if (config.contains("window")) {
        app.windowWidth = config["window"].value("width", 1024);
        app.windowHeight = config["window"].value("height", 768);
    }

    app.policy = Policy::load(readJson(app.assets / "policy.schema.json"), app.assets / "policy.json");
    require(app.policy.views.count(app.viewId), "Configured view is not in the policy.");
    auto homeOrigin = originOf(app.home);
    require(!homeOrigin.empty() && app.policy.views.at(app.viewId).origins.count(homeOrigin), "Home origin is not an allowed origin.");

    fs::path bun = package / "runtime/bun";
    if (!fs::exists(bun)) {
        // Distribution packages may relocate the nested executable to
        // Contents/Helpers (Apple's convention for helper binaries).
        fs::path helper = package.parent_path() / "Helpers/bun";
        if (fs::exists(helper)) bun = helper;
    }
    app.verifyBun(bun);
    for (auto it = app.manifest["assets"].begin(); it != app.manifest["assets"].end(); ++it) {
        require(sha256(app.package / fs::path(it.key())) == it.value().get<std::string>(), "Package asset hash mismatch.");
    }

    const char* homeEnv = getenv("HOME");
    require(homeEnv && *homeEnv, "HOME is not set.");
    app.scopes.dataRoot = fs::path(homeEnv) / "Library/Application Support/bunaway" / app.appId;
    app.scopes.appData = app.scopes.dataRoot / "data";
    app.scopes.temp = app.scopes.dataRoot / "temp";
    app.scopes.logsDir = app.scopes.dataRoot / "logs";
    app.scopes.webData = app.scopes.dataRoot / "webview";
    fs::create_directories(app.scopes.appData);
    fs::create_directories(app.scopes.temp);
    fs::create_directories(app.scopes.logsDir);
    fs::create_directories(app.scopes.webData);
    app.scopes.appDataCanonical = Scopes::canonicalOf(app.scopes.appData);
    app.scopes.tempCanonical = Scopes::canonicalOf(app.scopes.temp);
    app.hostLog = std::make_unique<Log>(app.scopes.logsDir / "host.log", 1024 * 1024);
    app.appLog = std::make_unique<Log>(app.scopes.logsDir / "app.log", 1024 * 1024);

    if (const char* delay = getenv("BUNAWAY_HOST_OP_DELAY_MS")) {
        long ms = std::strtol(delay, nullptr, 10);
        if (ms > 0 && ms <= 60000) app.hostOpDelayMs = static_cast<int>(ms);
    }
    app.runtimeId = app.appId;
    app.generation = randomHex(16);
    app.backendContext = "backend-" + randomHex(12);
    app.hostLog->event("host-init", { { "appId", app.appId }, { "runtime", { { "id", app.runtimeId }, { "generation", app.generation } } } });

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    BWAppDelegate* appDelegate = [[BWAppDelegate alloc] init];
    NSApp.delegate = appDelegate;

    NSRect rect = NSMakeRect(0, 0, app.windowWidth, app.windowHeight);
    app.window = [[NSWindow alloc]
        initWithContentRect:rect
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    app.window.title = nsstr(app.windowTitle);
    BWWindowDelegate* windowDelegate = [[BWWindowDelegate alloc] init];
    app.window.delegate = windowDelegate;

    WKWebViewConfiguration* wkconfig = [[WKWebViewConfiguration alloc] init];
    BWSchemeHandler* schemeHandler = [[BWSchemeHandler alloc] init];
    [wkconfig setURLSchemeHandler:schemeHandler forURLScheme:@"bunaway"];
    WKUserContentController* ucc = [[WKUserContentController alloc] init];
    BWScriptHandler* scriptHandler = [[BWScriptHandler alloc] init];
    [ucc addScriptMessageHandler:scriptHandler name:@"bunaway"];
    WKUserScript* shim = [[WKUserScript alloc] initWithSource:kBridgeShim
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO];
    [ucc addUserScript:shim];
    // Match resource destinations, not the top document's domain.
    NSString* rulesJson = nsstr(resourceRules(app.policy.views.at(app.viewId).origins).dump());
    [[WKContentRuleListStore defaultStore] compileContentRuleListForIdentifier:@"bunaway-boundary"
        encodedContentRuleList:rulesJson
        completionHandler:^(WKContentRuleList* list, NSError* error) {
            if (!g_app || g_app->shuttingDown) return;
            if (!list || error) {
                g_app->hostLog->event("content-rules-failed");
                g_app->runtimeFailure();
                return;
            }
            [ucc addContentRuleList:list];
            g_app->webviewReady.store(true);
            g_app->hostLog->event("webview-ready");
            g_app->navigateWhenReady();
        }];
    wkconfig.userContentController = ucc;
    // Non-persistent data store keeps web state inside the process and inside
    // the app's data root (no writes to ~/Library/WebKit).
    wkconfig.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];

    app.webview = [[WKWebView alloc] initWithFrame:rect configuration:wkconfig];
    BWNavDelegate* navDelegate = [[BWNavDelegate alloc] init];
    app.webview.navigationDelegate = navDelegate;
    app.webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [app.window.contentView addSubview:app.webview];

    [app.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    BWTickTarget* tickTarget = [[BWTickTarget alloc] init];
    [NSTimer scheduledTimerWithTimeInterval:0.25 target:tickTarget selector:@selector(tick:) userInfo:nil repeats:YES];

    // SIGTERM -> graceful close, matching WM_CLOSE semantics.
    static dispatch_source_t termSource;
    signal(SIGTERM, SIG_IGN);
    termSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(termSource, ^{
        if (g_app) g_app->beginClose(0);
    });
    dispatch_activate(termSource);

    const fs::path bunPath = bun;
    app.runtimeThread = std::thread([&app, bunPath] { app.runtimeMain(bunPath); });
    [NSApp run];
    app.beginClose(app.exitCode);
    if (app.runtimeThread.joinable()) app.runtimeThread.join();
    app.stopWorkers();
    for (auto& worker : app.hostWorkers) if (worker.joinable()) worker.join();
    g_app = nullptr;
    return app.exitCode;
}

// Guard mode: --guard <pgid>. fd 3 is a pipe held open by the host; EOF means
// the host is gone, so the whole Bun process group is SIGKILLed. Also exits
// once the group is empty so it never lingers after a clean shutdown.
int guard(const char* groupArg) {
    long pgid = std::stol(groupArg);
    struct pollfd pfd { 3, POLLIN | POLLHUP | POLLERR, 0 };
    for (;;) {
        int rc = poll(&pfd, 1, 200);
        if (rc > 0) {
            char buffer[256];
            ssize_t n = read(3, buffer, sizeof buffer);
            if (n <= 0) { kill(-static_cast<pid_t>(pgid), SIGKILL); return 0; }
        }
        if (kill(-static_cast<pid_t>(pgid), 0) != 0 && errno == ESRCH) return 0;
    }
}

int main(int argc, char** argv) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        try {
            if (argc == 2 && std::string(argv[1]) == "--validate") {
                readLines(STDIN_FILENO, [](const std::string& line) {
                    bool accepted = false;
                    try { auto input = parse(line); accepted = valid(input.at("schema"), input.at("value")); } catch (...) {}
                    writeAll(STDOUT_FILENO, accepted ? "true\n" : "false\n");
                });
                return 0;
            }
            if (argc > 2 && std::string(argv[1]) == "--watch") {
                // --watch <pid|g<pgid>>... waits for all targets to disappear.
                require(argc - 2 <= 64, "Too many watched processes.");
                writeAll(STDOUT_FILENO, "watch-ready\n");
                auto deadline = Clock::now() + std::chrono::seconds(15);
                for (;;) {
                    bool alive = false;
                    for (int i = 2; i < argc; ++i) {
                        std::string target = argv[i];
                        if (target[0] == 'g') {
                            if (groupSize(static_cast<pid_t>(std::stol(target.substr(1)))) > 0) alive = true;
                        } else {
                            if (processAlive(static_cast<pid_t>(std::stol(target)))) alive = true;
                        }
                    }
                    if (!alive) return 0;
                    require(Clock::now() < deadline, "Watch timeout.");
                    std::this_thread::sleep_for(std::chrono::milliseconds(25));
                }
            }
            if (argc == 3 && std::string(argv[1]) == "--guard") return guard(argv[2]);
            if (argc == 1) {
                // Bundled launch: the package root is the .app Resources dir.
                return run(fs::path([[[NSBundle mainBundle] resourcePath] UTF8String]));
            }
            require((argc == 3 || (argc == 5 && std::string(argv[3]) == "--dev-url")) &&
                std::string(argv[1]) == "--package", "Usage: app-host [--package <dir> [--dev-url <url>]]");
            return run(fs::canonical(fs::path(argv[2])), argc == 5 ? argv[4] : "");
        } catch (const std::exception& e) {
            std::fprintf(stderr, "app-host failed: %s\n", e.what());
            return 1;
        } catch (...) {
            std::fprintf(stderr, "app-host failed.\n");
            return 1;
        }
    }
}
