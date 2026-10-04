#include <windows.h>
#include <bcrypt.h>
#include <fcntl.h>
#include <io.h>
#include "json.hpp"
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <thread>
#include <vector>

using Json = nlohmann::json;
namespace fs = std::filesystem;
constexpr size_t maxFrame = 1'048'576;
const Json runtime = { { "id", "probe" }, { "generation", "1" } };
const Json ipc = { { "major", 1 }, { "minor", 0 } };

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() { reset(); }
    void reset(HANDLE h = nullptr) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = h; }
};

void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

HANDLE duplicateThread(HANDLE source) {
    HANDLE result = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &result, THREAD_TERMINATE, FALSE, 0), "Thread handle failed.");
    return result;
}

std::string utf8(const std::wstring& value) {
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    require(n > 0 || value.empty(), "Invalid path encoding.");
    std::string result(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), n, nullptr, nullptr);
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

class Probe {
    Handle job, process, input, output, stderrPipe, mainThread;
    DWORD childPid = 0;
    std::mutex outputMutex, queueMutex, stateMutex;
    std::condition_variable queued;
    std::deque<std::string> queue;
    bool writerDone = false;
    std::atomic<bool> ready = false, closing = false, failed = false, exited = false, forced = false, controllerDone = false, ioDone = false, outputAborted = false;
    bool helloSeen = false;
    std::atomic<ULONGLONG> closeTime = 0;
    std::map<std::string, std::string> pending;
    std::set<std::string> used;
    std::map<std::string, uint64_t> subscriptions;
    Json schema, manifest;

    void emit(const Json& value) {
        std::lock_guard lock(outputMutex);
        require(!outputAborted, "Host output cancelled.");
        writeAll(GetStdHandle(STD_OUTPUT_HANDLE), value.dump() + "\n");
    }
    void fail() {
        // Cleanup must start even when the controller is not consuming stdout.
        TerminateJobObject(job.value, 1);
        if (!failed.exchange(true)) {
            try { emit({ { "kind", "host-error" }, { "code", "INTERNAL" }, { "message", "Process IPC failed." } }); } catch (...) {}
        }
    }
    void send(const Json& frame, bool control = false) {
        std::string text = frame.dump() + "\n";
        require(text.size() <= maxFrame + 1, "Outgoing frame too large.");
        std::lock_guard lock(queueMutex);
        if (control) queue.clear();
        require(!writerDone && (control || queue.size() < 128), "Host output queue full.");
        queue.push_back(std::move(text));
        queued.notify_one();
    }
    Json frame(const char* kind) { return { { "kind", kind }, { "ipc", ipc }, { "runtime", runtime } }; }
    void stop() {
        if (!closing.exchange(true)) {
            closeTime.store(GetTickCount64());
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
            require(ready && value["context"] == "probe-view" && value["payload"]["protocol"] == ipc, "Invalid backend route.");
            auto message = value["payload"];
            auto tag = message["kind"].get<std::string>();
            std::lock_guard lock(stateMutex);
            if (tag == "result" || tag == "error") {
                auto id = message["id"].get<std::string>();
                auto request = pending.find(id);
                if (request == pending.end()) { emit({ { "kind", "host-discarded" }, { "reason", "late-response" } }); return; }
                if (tag == "result" && request->second == "listen") {
                    require(message["payload"].is_object() && message["payload"].size() == 1 && message["payload"]["subscriptionId"].is_string(), "Invalid subscription result.");
                    subscriptions[message["payload"]["subscriptionId"].get<std::string>()] = 0;
                }
                pending.erase(request);
            } else if (tag == "event") {
                auto sub = subscriptions.find(message["subscriptionId"].get<std::string>());
                if (sub == subscriptions.end()) { emit({ { "kind", "host-discarded" }, { "reason", "inactive-subscription" } }); return; }
                require(message["source"] == "backend" && message["target"] == "probe-view" && message["event"] == "probe.changed" && message["sequence"].get<uint64_t>() == ++sub->second, "Invalid event order.");
            } else if (tag == "subscription-error") subscriptions.erase(message["subscriptionId"].get<std::string>());
            else throw std::runtime_error("Unexpected backend message.");
        } else if (kind == "stopping") require(closing, "Unexpected stop.");
        else if (kind == "fatal") { emit(value); fail(); return; }
        else throw std::runtime_error("Invalid backend direction.");
        emit(value);
    }
    void fromController(const std::string& line) {
        auto value = parse(line);
        require(valid(schema, value) && value["runtime"] == runtime, "Invalid controller envelope.");
        if (value["kind"] == "shutdown") { stop(); return; }
        require(ready && !closing, "Backend not ready.");
        if (value["kind"] == "revoke") {
            require(value["context"] == "probe-view", "Invalid context.");
            { std::lock_guard lock(stateMutex); subscriptions.clear(); }
        } else {
            require(value["kind"] == "web" && value["context"] == "probe-view", "Invalid controller direction.");
            auto message = value["payload"];
            require(message["protocol"] == ipc, "Wrong negotiated protocol.");
            auto kind = message["kind"].get<std::string>();
            require(kind == "invoke" || kind == "listen" || kind == "unlisten", "Invalid controller message.");
            std::lock_guard lock(stateMutex);
            auto id = message["id"].get<std::string>();
            require(used.size() < 1024 && used.insert(id).second && pending.size() < 128, "Request ID reused or limit exceeded.");
            pending[id] = kind;
            if (kind == "unlisten") subscriptions.erase(message["subscriptionId"].get<std::string>());
        }
        send(value);
    }
public:
    int run(const fs::path& package, const std::wstring& mode) {
        schema = readJson(package / "assets/process.schema.json");
        manifest = readJson(package / "manifest.json");
        const fs::path bun = package / "runtime/bun.exe";
        require(sha256(bun) == manifest["bun"]["executableSha256"].get<std::string>(), "Bun executable hash mismatch.");
        for (auto it = manifest["assets"].begin(); it != manifest["assets"].end(); ++it) require(sha256(package / fs::path(std::u8string(it.key().begin(), it.key().end()))) == it.value().get<std::string>(), "Package asset hash mismatch.");
        HANDLE rawJob = CreateJobObjectW(nullptr, nullptr);
        require(rawJob != nullptr, "Job creation failed."); job.reset(rawJob);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof limits), "Job limits failed.");
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
        auto assets = package / "assets";
        fs::create_directories(assets / "tmp");
        std::map<std::wstring, std::wstring> env = {
            { L"BUN_RUNTIME_TRANSPILER_CACHE_PATH", L"0" }, { L"DO_NOT_TRACK", L"1" },
            { L"HOME", assets.wstring() }, { L"NO_COLOR", L"1" }, { L"PATH", fs::path(windows).wstring() + L"\\System32" },
            { L"SystemRoot", windows }, { L"TEMP", (assets / "tmp").wstring() }, { L"TMP", (assets / "tmp").wstring() }, { L"USERPROFILE", assets.wstring() }
        };
        std::vector<wchar_t> block;
        for (const auto& [key, val] : env) { auto entry = key + L"=" + val; block.insert(block.end(), entry.begin(), entry.end()); block.push_back(0); }
        block.push_back(0);
        std::wstring command = quote(bun.wstring()) + L" --no-env-file --no-install " + quote(L"--config=" + (assets / "bunfig.toml").wstring()) + L" " + quote(L"--tsconfig-override=" + (assets / "tsconfig.json").wstring()) + L" " + quote((assets / "backend.js").wstring()) + L" " + quote(mode);
        PROCESS_INFORMATION info {};
        require(CreateProcessW(bun.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, block.data(), assets.c_str(), &startup.StartupInfo, &info), "Bun process creation failed.");
        process.reset(info.hProcess); Handle thread(info.hThread); childPid = info.dwProcessId;
        if (!AssignProcessToJobObject(job.value, process.value)) { TerminateProcess(process.value, 1); WaitForSingleObject(process.value, 5000); throw std::runtime_error("Job assignment failed."); }
        try {
            emit({ { "kind", "host-started" }, { "hostPid", GetCurrentProcessId() }, { "childPid", childPid }, { "bunPath", utf8(bun.wstring()) }, { "runtime", runtime } });
            require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "Bun resume failed.");
        } catch (...) { TerminateJobObject(job.value, 1); WaitForSingleObject(process.value, 5000); throw; }
        childInput.reset(); childOutput.reset(); childError.reset();
        mainThread.reset(duplicateThread(GetCurrentThread()));
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
            char data[8192]; DWORD n = 0; size_t forwarded = 0;
            while (!outputAborted && ReadFile(stderrPipe.value, data, sizeof data, &n, nullptr) && n) {
                if (!outputAborted && forwarded < 65536) { auto bytes = std::min<size_t>(n, 65536 - forwarded); try { writeAll(GetStdHandle(STD_ERROR_HANDLE), std::string(data, bytes)); } catch (...) {} forwarded += bytes; }
            }
        });
        // Own stable handles while the main thread joins the std::threads.
        Handle writerThread(duplicateThread(writer.native_handle()));
        Handle readerThread(duplicateThread(reader.native_handle()));
        Handle logsThread(duplicateThread(logs.native_handle()));
        std::thread monitor([&] {
            ULONGLONG started = GetTickCount64();
            while (WaitForSingleObject(process.value, 10) == WAIT_TIMEOUT) {
                if ((!ready && GetTickCount64() - started > 10000) || (closing && closeTime.load() && GetTickCount64() - closeTime.load() > 2000)) {
                    forced.store(true); TerminateJobObject(job.value, 1);
                }
            }
            exited.store(true);
            TerminateJobObject(job.value, 1);
            { std::lock_guard lock(queueMutex); writerDone = true; queued.notify_one(); }
            const auto deadline = GetTickCount64() + 2000;
            // Keep cancellation active through joins AND final diagnostic writes.
            // A single cancellation can race with the next synchronous I/O call.
            while (!ioDone) {
                if (!controllerDone) CancelSynchronousIo(mainThread.value);
                CancelSynchronousIo(writerThread.value);
                if (GetTickCount64() >= deadline) {
                    outputAborted.store(true); failed.store(true);
                    CancelSynchronousIo(mainThread.value);
                    CancelSynchronousIo(readerThread.value);
                    CancelSynchronousIo(logsThread.value);
                }
                Sleep(5);
            }
        });
        try {
            auto boot = frame("boot"); boot["payload"] = { { "entrypoint", utf8((assets / "backend.js").wstring()) }, { "buildId", "windows-probe" } }; send(boot);
            auto hello = frame("hello"); hello["payload"] = { { "kind", "hello" }, { "protocol", ipc }, { "features", Json::array() }, { "buildId", "windows-host" } }; send(hello);
            if (!exited) readLines(GetStdHandle(STD_INPUT_HANDLE), [&](const std::string& line) { fromController(line); });
            if (!exited) stop();
        } catch (...) { if (!exited) fail(); }
        controllerDone.store(true);
        writer.join(); reader.join(); logs.join();
        int result = 1;
        try {
            DWORD code = 1; require(GetExitCodeProcess(process.value, &code), "Exit code failed.");
            { std::lock_guard lock(stateMutex); for (const auto& [id, _] : pending) {
                auto response = frame("web"); response["context"] = "probe-view";
                response["payload"] = { { "kind", "error" }, { "protocol", ipc }, { "id", id }, { "error", { { "code", "INTERNAL" }, { "message", "Backend connection closed." } } } }; emit(response);
            } }
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting {};
            ULONGLONG deadline = GetTickCount64() + 5000;
            do {
                require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, nullptr), "Job accounting failed.");
                if (!accounting.ActiveProcesses) break;
                Sleep(10);
            } while (GetTickCount64() < deadline);
            require(accounting.ActiveProcesses == 0, "Child processes remain.");
            emit({ { "kind", "host-stopped" }, { "exitCode", code }, { "forced", forced.load() }, { "failed", failed.load() || !closing }, { "activeProcesses", accounting.ActiveProcesses }, { "childPid", childPid } });
            result = failed || forced || code != 0 || !closing ? 1 : 0;
        } catch (...) { failed.store(true); }
        ioDone.store(true);
        monitor.join();
        return failed ? 1 : result;
    }
};

int wmain(int argc, wchar_t** argv) {
    _setmode(_fileno(stdout), _O_BINARY); _setmode(_fileno(stderr), _O_BINARY);
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"--validate") {
            // Test-only mode: exercise the exact validator used by both IPC routes.
            readLines(GetStdHandle(STD_INPUT_HANDLE), [](const std::string& line) {
                bool accepted = false;
                try { auto input = parse(line); accepted = valid(input.at("schema"), input.at("value")); } catch (...) {}
                writeAll(GetStdHandle(STD_OUTPUT_HANDLE), accepted ? "true\n" : "false\n");
            });
            return 0;
        }
        if (argc > 2 && std::wstring(argv[1]) == L"--watch") {
            std::vector<HANDLE> watched;
            for (int i = 2; i < argc; ++i) {
                auto handle = OpenProcess(SYNCHRONIZE, FALSE, std::stoul(argv[i]));
                require(handle != nullptr, "Watch process missing."); watched.push_back(handle);
            }
            require(watched.size() <= MAXIMUM_WAIT_OBJECTS, "Too many watched processes.");
            writeAll(GetStdHandle(STD_OUTPUT_HANDLE), "watch-ready\n");
            auto result = WaitForMultipleObjects(static_cast<DWORD>(watched.size()), watched.data(), TRUE, 10000);
            for (auto handle : watched) CloseHandle(handle);
            return result == WAIT_OBJECT_0 ? 0 : 1;
        }
        wchar_t location[32768]; DWORD n = GetModuleFileNameW(nullptr, location, 32768);
        require(n && n < 32768, "Host path failed.");
        Probe probe;
        return probe.run(fs::path(location).parent_path(), argc > 1 ? argv[1] : L"normal");
    } catch (...) {
        std::cerr << "Probe startup failed.\n";
        return 1;
    }
}
