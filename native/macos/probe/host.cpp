// macOS minimal probe host — POSIX bundled-process feasibility probe.
// Spawns the bundled Bun executable as a child process in its own process
// group, talks NDJSON over dedicated stdin/stdout pipes, and cleans the
// process tree on clean, timed-out and abnormal exit.
//
// Windows uses a kill-on-close Job Object so Bun dies with the host. POSIX
// has no equivalent, so the host spawns a tiny `--guard` watchdog process
// that holds one end of a pipe: when the host dies the pipe hits EOF and the
// guard SIGKILLs the Bun process group. Residual race: if the host dies in
// the microsecond window between the Bun spawn and the guard spawn, Bun is
// left running — same binary, so the guard adds near-zero attack surface.
#include <spawn.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <signal.h>
#include <sys/poll.h>
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
#include <iostream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <vector>
#include "json.hpp"

using Json = nlohmann::json;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
constexpr size_t maxFrame = 1'048'576;
const Json runtime = { { "id", "probe" }, { "generation", "1" } };
const Json ipc = { { "major", 1 }, { "minor", 0 } };

struct Fd {
    int value = -1;
    Fd() = default;
    explicit Fd(int fd) : value(fd) {}
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    ~Fd() { reset(); }
    void reset(int fd = -1) { if (value >= 0) close(value); value = fd; }
};

void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

Json parse(const std::string& text) {
    require(!text.empty() && text.size() <= maxFrame, "Invalid frame length.");
    return Json::parse(text, [](int depth, Json::parse_event_t event, Json& value) {
        require(depth <= 64, "JSON depth exceeded.");
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
        // UTF-8 byte regex: supports the tested built-in patterns, not arbitrary app schemas.
        if (schema.contains("pattern") && !std::regex_search(string, std::regex(schema["pattern"].get<std::string>()))) return false;
    } else if (type == "integer" || type == "number") {
        if (!value.is_number() || !std::isfinite(value.get<double>())) return false;
        if (type == "integer" && (std::floor(value.get<double>()) != value.get<double>() || std::abs(value.get<double>()) > 9007199254740991.0)) return false;
        if (schema.contains("minimum") && value.get<double>() < schema["minimum"].get<double>()) return false;
        if (schema.contains("maximum") && value.get<double>() > schema["maximum"].get<double>()) return false;
    } else if (type == "boolean" && !value.is_boolean()) return false;
    return true;
}

// Minimal SHA-256 (FIPS 180-4) so the host has no crypto dependency.
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

int64_t monoMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
}

// pipe(2) with FD_CLOEXEC on both ends: without it the Bun child would inherit
// the death-pipe write end and the watchdog would never see host death.
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

// Bounded non-blocking write: a consumer that stalls stdout must not wedge
// the writer. Allow a consuming controller to receive teardown frames even
// after failure; abort only when the deadline passes or the fd is dead.
bool writeBounded(int fd, const std::string& text) {
    auto deadline = Clock::now() + std::chrono::seconds(2);
    size_t offset = 0;
    while (offset < text.size()) {
        ssize_t written = write(fd, text.data() + offset, text.size() - offset);
        if (written > 0) { offset += static_cast<size_t>(written); continue; }
        if (written < 0 && errno == EINTR) continue;
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (Clock::now() >= deadline) return false;
            struct pollfd pfd { fd, POLLOUT | POLLERR | POLLHUP, 0 };
            int rc = poll(&pfd, 1, 50);
            if (rc > 0 && (pfd.revents & (POLLERR | POLLHUP | POLLNVAL))) return false;
            continue;
        }
        return false; // EPIPE or other write error
    }
    return true;
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

// kill(pid,0) reports zombies as alive; treat SZOMB as dead so the guard and
// the group accounting do not wait on corpses launchd has not reaped yet.
bool processAlive(pid_t pid) {
    if (kill(pid, 0) != 0) return errno == EPERM;
    struct proc_bsdinfo info {};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) == sizeof info && info.pbi_status == 5) return false; // 5 = SZOMB
    return true;
}

// Count live members of a process group (0 = none). Windows: JobObjectBasicAccountingInformation.
int groupSize(pid_t pgid) {
    pid_t pids[1024];
    int bytes = proc_listpids(PROC_PGRP_ONLY, static_cast<uint32_t>(pgid), pids, sizeof pids);
    int count = 0;
    if (bytes > 0) for (int i = 0; i < bytes / static_cast<int>(sizeof(pid_t)); ++i) if (processAlive(pids[i])) ++count;
    return count;
}

// State transitions and their controller output commit under the same lock.
// The sink only enqueues output and must not reenter this object. During normal
// operation it never waits; final close may wait for bounded queue capacity.
class ProbeContext {
    std::mutex mutex;
    bool revoked = false;
    std::map<std::string, std::string> pending;
    std::set<std::string> used;
    std::map<std::string, uint64_t> subscriptions;
    std::function<void(std::string)> output;

    void reject(const std::string& id, const char* code, const char* message) {
        output(Json { { "kind", "web" }, { "ipc", ipc }, { "runtime", runtime }, { "context", "probe-view" },
            { "payload", { { "kind", "error" }, { "protocol", ipc }, { "id", id },
                { "error", { { "code", code }, { "message", message } } } } } }.dump());
    }
    void finish(const char* code, const char* message) {
        revoked = true;
        subscriptions.clear();
        for (const auto& [id, _] : pending) reject(id, code, message);
        pending.clear();
    }
    void discard(const char* reason) {
        output(Json { { "kind", "host-discarded" }, { "reason", reason } }.dump());
    }
public:
    explicit ProbeContext(std::function<void(std::string)> sink) : output(std::move(sink)) {}

    // Called only after envelope validation. False means the request was answered locally.
    bool accept(const Json& value) {
        std::lock_guard lock(mutex);
        if (value["kind"] == "revoke") {
            require(value["context"] == "probe-view", "Invalid context.");
            finish("CANCELLED", "Context revoked.");
            return true;
        }
        require(value["kind"] == "web" && value["context"] == "probe-view", "Invalid controller direction.");
        auto message = value["payload"];
        require(message["protocol"] == ipc, "Wrong negotiated protocol.");
        auto kind = message["kind"].get<std::string>();
        require(kind == "invoke" || kind == "listen" || kind == "unlisten", "Invalid controller message.");
        auto id = message["id"].get<std::string>();
        require(used.size() < 1024 && used.insert(id).second && pending.size() < 128, "Request ID reused or limit exceeded.");
        if (revoked) { reject(id, "CANCELLED", "Context revoked."); return false; }
        pending[id] = kind;
        if (kind == "unlisten") subscriptions.erase(message["subscriptionId"].get<std::string>());
        return true;
    }
    // Preserve validated wire bytes rather than reserializing received numbers.
    void deliver(const Json& value, const std::string& line) {
        require(value["context"] == "probe-view" && value["payload"]["protocol"] == ipc, "Invalid backend route.");
        auto message = value["payload"];
        auto tag = message["kind"].get<std::string>();
        std::lock_guard lock(mutex);
        if (revoked) { discard(tag == "result" || tag == "error" ? "late-response" : "inactive-subscription"); return; }
        if (tag == "result" || tag == "error") {
            auto id = message["id"].get<std::string>();
            auto request = pending.find(id);
            if (request == pending.end()) { discard("late-response"); return; }
            if (tag == "result" && request->second == "listen") {
                require(message["payload"].is_object() && message["payload"].size() == 1 && message["payload"]["subscriptionId"].is_string(), "Invalid subscription result.");
                subscriptions[message["payload"]["subscriptionId"].get<std::string>()] = 0;
            }
            pending.erase(request);
        } else if (tag == "event") {
            auto sub = subscriptions.find(message["subscriptionId"].get<std::string>());
            if (sub == subscriptions.end()) { discard("inactive-subscription"); return; }
            require(message["source"] == "backend" && message["target"] == "probe-view" && message["event"] == "probe.changed" && message["sequence"].get<uint64_t>() == ++sub->second, "Invalid event order.");
        } else if (tag == "subscription-error") subscriptions.erase(message["subscriptionId"].get<std::string>());
        else throw std::runtime_error("Unexpected backend message.");
        output(line);
    }
    void close() {
        std::lock_guard lock(mutex);
        finish("INTERNAL", "Backend connection closed.");
    }
};

class Probe {
    Fd input, output, stderrPipe;
    Fd deathWrite;
    pid_t childPid = -1;
    pid_t guardPidValue = -1;
    std::mutex outputMutex, queueMutex;
    std::condition_variable queued, outputQueued;
    std::deque<std::string> queue, outputQueue;
    bool writerDone = false, outputDone = false, finalizingOutput = false;
    std::atomic<bool> ready = false, closing = false, failed = false, exited = false, forced = false, controllerDone = false, ioDone = false, outputAborted = false;
    bool helloSeen = false;
    std::atomic<int64_t> closeTimeMs = 0;
    std::atomic<int> childStatus = 0;
    ProbeContext context { [this](std::string line) { emitLine(std::move(line)); } };
    Json schema, manifest;

    void emitLine(std::string text) {
        require(text.size() <= maxFrame, "Controller frame too large.");
        text += '\n';
        std::unique_lock lock(outputMutex);
        // The backend/controller producers have joined before final close. A
        // burst of pending-request errors must not discard host-stopped merely
        // because the output writer has not been scheduled yet.
        if (finalizingOutput) outputQueued.wait_for(lock, std::chrono::seconds(2), [&] {
            return outputAborted || outputDone || outputQueue.size() < 128;
        });
        require(!outputAborted && !outputDone && outputQueue.size() < 128, "Host output unavailable or full.");
        outputQueue.push_back(std::move(text));
        outputQueued.notify_one();
    }
    void emit(const Json& value) { emitLine(value.dump()); }
    void fail() {
        // Cleanup must start even when the controller is not consuming stdout.
        if (childPid > 0) { killpg(childPid, SIGKILL); }
        if (!failed.exchange(true)) {
            try { emit({ { "kind", "host-error" }, { "code", "INTERNAL" }, { "message", "Process IPC failed." } }); } catch (...) {}
        }
    }
    void sendLine(std::string text, bool control = false) {
        require(text.size() <= maxFrame, "Outgoing frame too large.");
        text += '\n';
        std::lock_guard lock(queueMutex);
        if (control) queue.clear();
        require(!writerDone && (control || queue.size() < 128), "Host output queue full.");
        queue.push_back(std::move(text));
        queued.notify_one();
    }
    void send(const Json& value, bool control = false) { sendLine(value.dump(), control); }
    Json frame(const char* kind) { return { { "kind", kind }, { "ipc", ipc }, { "runtime", runtime } }; }
    void stop() {
        if (!closing.exchange(true)) {
            closeTimeMs.store(monoMs());
            send(frame("shutdown"), true);
        }
    }
    void fromBackend(const std::string& line) {
        auto value = parse(line);
        require(valid(schema, value) && value["runtime"] == runtime, "Invalid backend envelope.");
        auto kind = value["kind"].get<std::string>();
        if (kind == "hello") {
            require(!helloSeen && !ready && value["payload"]["protocol"] == ipc, "Protocol negotiation failed.");
            helloSeen = true;
        } else if (kind == "ready") {
            require(helloSeen && !ready && value["pid"] == childPid && value["bunVersion"] == manifest["bun"]["version"] && value["revision"] == manifest["bun"]["sourceRevision"], "Unexpected runtime identity.");
            ready.store(true);
        } else if (kind == "web") {
            require(ready, "Invalid backend route.");
            context.deliver(value, line);
            return;
        } else if (kind == "stopping") require(closing, "Unexpected stop.");
        else if (kind == "fatal") { emitLine(line); fail(); return; }
        else throw std::runtime_error("Invalid backend direction.");
        emitLine(line);
    }
    void fromController(const std::string& line) {
        auto value = parse(line);
        require(valid(schema, value) && value["runtime"] == runtime, "Invalid controller envelope.");
        if (value["kind"] == "shutdown") { stop(); return; }
        require(ready && !closing, "Backend not ready.");
        if (!context.accept(value)) return;
        // Relay only after validation and routing; keep the original wire byte size.
        sendLine(line);
    }

    // Spawn the bundled Bun in its own session so its pgid equals its pid.
    void spawnBun(const fs::path& package, const std::string& mode) {
        const fs::path bun = package / "runtime/bun";
        require(sha256(bun) == manifest["bun"]["executableSha256"].get<std::string>(), "Bun executable hash mismatch.");
        int inPipe[2], outPipe[2], errPipe[2], deathPipe[2];
        makePipe(inPipe); makePipe(outPipe); makePipe(errPipe); makePipe(deathPipe);
        input.reset(inPipe[1]); output.reset(outPipe[0]); stderrPipe.reset(errPipe[0]); deathWrite.reset(deathPipe[1]);
        auto assets = package / "assets";
        fs::create_directories(assets / "tmp");
        auto entry = (assets / "backend.js").string();
        auto config = std::string("--config=") + (assets / "bunfig.toml").string();
        auto tsconfig = std::string("--tsconfig-override=") + (assets / "tsconfig.json").string();
        std::vector<std::string> argStore = {
            bun.string(), "--no-env-file", "--no-install", config, tsconfig, entry, mode
        };
        std::vector<char*> argv;
        for (auto& arg : argStore) argv.push_back(arg.data());
        argv.push_back(nullptr);
        std::vector<std::string> envStore = {
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "DO_NOT_TRACK=1",
            "HOME=" + assets.string(), "NO_COLOR=1", "PATH=/usr/bin:/bin",
            "TMPDIR=" + (assets / "tmp").string()
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
        // Own process group: pgid == child pid so killpg(-pid) covers descendants.
        // (SETPGROUP alone suffices for killpg; the child shares the host session
        // but never sees a controlling terminal because stdio is pipes.)
        require(posix_spawnattr_setpgroup(&attr, 0) == 0, "Spawn group failed.");
        require(posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP) == 0, "Spawn flags failed.");
        int error = posix_spawn(&childPid, bun.c_str(), &actions, &attr, argv.data(), envp.data());
        posix_spawn_file_actions_destroy(&actions);
        posix_spawnattr_destroy(&attr);
        close(inPipe[0]); close(outPipe[1]); close(errPipe[1]);
        require(error == 0, "Bun process creation failed.");

        // Job Object analog: watchdog kills the group if this host dies.
        int guardPid = 0;
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
            guardPidValue = guardPid;
        }
    }
public:
    static fs::path executablePath() {
        uint32_t size = 0;
        _NSGetExecutablePath(nullptr, &size);
        std::vector<char> buffer(size);
        require(_NSGetExecutablePath(buffer.data(), &size) == 0, "Host path failed.");
        return fs::weakly_canonical(fs::path(buffer.data()));
    }

    int run(const fs::path& package, const std::string& mode) {
        schema = readJson(package / "assets/process.schema.json");
        manifest = readJson(package / "manifest.json");
        for (auto it = manifest["assets"].begin(); it != manifest["assets"].end(); ++it)
            require(sha256(package / fs::path(it.key())) == it.value().get<std::string>(), "Package asset hash mismatch.");
        spawnBun(package, mode);
        emit({ { "kind", "host-started" }, { "hostPid", getpid() }, { "childPid", childPid }, { "guardPid", guardPidValue }, { "bunPath", (package / "runtime/bun").string() }, { "runtime", runtime } });
        // stdout may be a pipe whose reader stalls; make it non-blocking so the
        // output writer can enforce its 2 s stall bound instead of parking in write().
        int stdoutFlags = fcntl(STDOUT_FILENO, F_GETFL);
        require(stdoutFlags >= 0 && fcntl(STDOUT_FILENO, F_SETFL, stdoutFlags | O_NONBLOCK) == 0, "stdout flags failed.");
        std::thread outputWriter([&] {
            try {
                for (;;) {
                    std::string next;
                    {
                        std::unique_lock lock(outputMutex);
                        outputQueued.wait(lock, [&] { return outputDone || !outputQueue.empty(); });
                        if (outputAborted || (outputDone && outputQueue.empty())) break;
                        next = std::move(outputQueue.front()); outputQueue.pop_front();
                        outputQueued.notify_all();
                    }
                    if (!writeBounded(STDOUT_FILENO, next)) { outputAborted.store(true); outputQueued.notify_all(); fail(); break; }
                }
            } catch (...) { outputAborted.store(true); outputQueued.notify_all(); fail(); }
        });
        std::thread writer([&] {
            try {
                for (;;) {
                    std::string next;
                    { std::unique_lock lock(queueMutex); queued.wait(lock, [&] { return writerDone || !queue.empty(); }); if (writerDone) break; next = std::move(queue.front()); queue.pop_front(); }
                    writeAll(input.value, next);
                }
            } catch (...) { if (!exited) fail(); }
        });
        std::thread reader([&] {
            try {
                readLines(output.value, [&](const std::string& line) { fromBackend(line); });
                if (!closing && !outputAborted) fail();
            } catch (...) { if (!outputAborted) fail(); }
        });
        std::thread logs([&] {
            char data[8192]; ssize_t n = 0; size_t forwarded = 0;
            while (!outputAborted && (n = read(stderrPipe.value, data, sizeof data)) > 0) {
                if (!outputAborted && forwarded < 65536) { auto bytes = std::min<size_t>(static_cast<size_t>(n), 65536 - forwarded); try { writeAll(STDERR_FILENO, std::string(data, bytes)); } catch (...) {} forwarded += bytes; }
            }
        });
        std::thread monitor([&] {
            auto startedMs = monoMs();
            int status = 0;
            while (waitpid(childPid, &status, WNOHANG) == 0) {
                int64_t now = monoMs();
                if ((!ready && now - startedMs > 10000) || (closing && closeTimeMs.load() && now - closeTimeMs.load() > 2000)) {
                    forced.store(true); killpg(childPid, SIGKILL);
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            exited.store(true);
            childStatus.store(status);
            killpg(childPid, SIGKILL); // sweep descendants still in the group
            { std::lock_guard lock(queueMutex); writerDone = true; queued.notify_one(); }
            // The death pipe closes on process exit, which releases the guard.
        });
        try {
            auto boot = frame("boot"); boot["payload"] = { { "entrypoint", (package / "assets/backend.js").string() }, { "buildId", "macos-probe" } }; send(boot);
            auto hello = frame("hello"); hello["payload"] = { { "kind", "hello" }, { "protocol", ipc }, { "features", Json::array() }, { "buildId", "macos-host" } }; send(hello);
            if (!exited) {
                // Poll stdin so a dead backend still lets the main thread leave the loop.
                struct pollfd pfd { STDIN_FILENO, POLLIN | POLLHUP | POLLERR, 0 };
                std::string pending;
                char buffer[8192];
                for (;;) {
                    int rc = poll(&pfd, 1, 50);
                    if (exited) break;
                    if (rc < 0) { if (errno == EINTR) continue; require(false, "Controller poll failed."); }
                    if (rc == 0) continue;
                    ssize_t length = read(STDIN_FILENO, buffer, sizeof buffer);
                    if (length <= 0) break;
                    for (ssize_t i = 0; i < length; ++i) {
                        if (buffer[i] == '\n') { fromController(pending); pending.clear(); }
                        else { require(pending.size() < maxFrame, "Process frame exceeds limit."); pending += buffer[i]; }
                    }
                }
                require(pending.empty(), "Incomplete process frame.");
            }
            if (!exited) stop();
        } catch (...) { if (!exited) fail(); }
        controllerDone.store(true);
        writer.join(); reader.join(); logs.join();
        { std::lock_guard lock(outputMutex); finalizingOutput = true; }
        int result = 1;
        try {
            int status = childStatus.load();
            int code = 1;
            if (WIFEXITED(status)) code = WEXITSTATUS(status);
            else if (WIFSIGNALED(status)) code = 128 + WTERMSIG(status);
            context.close();
            // JobObjectBasicAccountingInformation analog: group must drain to zero.
            int remaining = -1;
            auto deadline = Clock::now() + std::chrono::seconds(5);
            do {
                remaining = groupSize(childPid);
                if (!remaining) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            } while (Clock::now() < deadline);
            require(remaining == 0, "Child processes remain.");
            emit({ { "kind", "host-stopped" }, { "exitCode", code }, { "forced", forced.load() }, { "failed", failed.load() || !closing }, { "activeProcesses", remaining }, { "childPid", childPid } });
            result = failed || forced || code != 0 || !closing ? 1 : 0;
        } catch (...) { failed.store(true); }
        { std::lock_guard lock(outputMutex); outputDone = true; outputQueued.notify_one(); }
        outputWriter.join();
        ioDone.store(true);
        monitor.join();
        if (guardPidValue > 0) { int s; waitpid(guardPidValue, &s, 0); }
        return failed ? 1 : result;
    }
};

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
            auto deadline = Clock::now() + std::chrono::seconds(10);
            for (;;) {
                bool alive = false;
                for (int i = 2; i < argc; ++i) {
                    std::string target = argv[i];
                    if (target[0] == 'g') {
                        if (groupSize(std::stol(target.substr(1))) > 0) alive = true;
                    } else {
                        if (processAlive(std::stol(target))) alive = true;
                    }
                }
                if (!alive) return 0;
                require(Clock::now() < deadline, "Watch timeout.");
                std::this_thread::sleep_for(std::chrono::milliseconds(25));
            }
            return 0;
        }
        if (argc == 3 && std::string(argv[1]) == "--guard") return guard(argv[2]);
        fs::path self = Probe::executablePath();
        Probe probe;
        return probe.run(self.parent_path(), argc > 1 ? argv[1] : "normal");
    } catch (...) {
        std::cerr << "Probe startup failed.\n";
        return 1;
    }
}
