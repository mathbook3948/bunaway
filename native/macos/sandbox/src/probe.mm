// Sandbox experiment probe for bunaway's App Sandbox feasibility checks.
// Emits one NDJSON line per observation so run.sh can assemble results.
//
//   probe report <workdir>
//       self state: sandbox_check, HOME mapping, write probes, net client
//   probe spawn [--timeout <ms>] <child> [args...]
//       posix_spawn <child> with piped stdout/stderr, bounded wait
//   probe write <path>
//       one actual write attempt (errno reported)
//
// The probe deliberately uses only interfaces the real host uses
// (posix_spawn + pipes + plain fs) so results transfer to product code.

#include <Foundation/Foundation.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <filesystem>
#include <netinet/in.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <xpc/xpc.h>

namespace fs = std::filesystem;

extern char** environ;

// Private-but-stable Seatbelt query; libSystem exports it and Chromium/WebKit
// use the same call to detect sandbox state. Returns 0 when allowed.
extern "C" int sandbox_check(pid_t pid, const char* operation, int type, ...);
static constexpr int SANDBOX_FILTER_PATH = 1;

// The audit-token entitlement lookup WebKit's XPC services perform on the
// client app (hasEntitlement). Declared private; links against Security.
typedef struct __SecTask* SecTaskRef;
extern "C" SecTaskRef SecTaskCreateFromSelf(CFAllocatorRef allocator);
extern "C" CFTypeRef SecTaskCopyValueForEntitlement(SecTaskRef task, CFStringRef entitlement, CFErrorRef* error);

static void jsonEscape(FILE* out, const char* s) {
    fputc('"', out);
    for (const unsigned char* p = (const unsigned char*)s; *p; ++p) {
        switch (*p) {
            case '"': fputs("\\\"", out); break;
            case '\\': fputs("\\\\", out); break;
            case '\n': fputs("\\n", out); break;
            case '\r': fputs("\\r", out); break;
            case '\t': fputs("\\t", out); break;
            default:
                if (*p < 0x20) fprintf(out, "\\u%04x", *p);
                else fputc(*p, out);
        }
    }
    fputc('"', out);
}

// {"t":"<tag>","k":"<key>","v":<raw json>}
static void emit(const char* tag, const char* key, const char* rawJson) {
    fputs("{\"t\":", stdout); jsonEscape(stdout, tag);
    fputs(",\"k\":", stdout); jsonEscape(stdout, key);
    fputs(",\"v\":", stdout); fputs(rawJson, stdout);
    fputs("}\n", stdout); fflush(stdout);
}
static void emitStr(const char* tag, const char* key, const char* v) {
    fputs("{\"t\":", stdout); jsonEscape(stdout, tag);
    fputs(",\"k\":", stdout); jsonEscape(stdout, key);
    fputs(",\"v\":", stdout); jsonEscape(stdout, v ? v : "");
    fputs("}\n", stdout); fflush(stdout);
}
static void emitInt(const char* tag, const char* key, long v) {
    char buf[32]; snprintf(buf, sizeof buf, "%ld", v); emit(tag, key, buf);
}
static void emitBool(const char* tag, const char* key, bool v) {
    emit(tag, key, v ? "true" : "false");
}

// Attempt an actual write; returns errno on failure, 0 on success.
static int tryWrite(const char* path) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return errno;
    if (write(fd, "bunaway-sandbox-probe\n", 22) != 22) { int e = errno; close(fd); return e; }
    if (close(fd) != 0) return errno;
    return 0;
}

static int report(const char* workdir) {
    emitStr("env", "HOME", getenv("HOME"));
    emitStr("env", "NSHomeDirectory", [NSHomeDirectory() UTF8String]);
    char buf[PATH_MAX];
    buf[0] = 0;
    confstr(_CS_DARWIN_USER_DIR, buf, sizeof buf);
    emitStr("env", "CS_DARWIN_USER_DIR", buf);
    buf[0] = 0;
    confstr(_CS_DARWIN_USER_TEMP_DIR, buf, sizeof buf);
    emitStr("env", "CS_DARWIN_USER_TEMP_DIR", buf);
    buf[0] = 0;
    confstr(_CS_DARWIN_USER_CACHE_DIR, buf, sizeof buf);
    emitStr("env", "CS_DARWIN_USER_CACHE_DIR", buf);

    // Seatbelt's own view of two operations vs. actual outcomes.
    emitInt("sandbox_check", "file-write-data /", sandbox_check(getpid(), "file-write-data", SANDBOX_FILTER_PATH, "/"));
    emitInt("sandbox_check", "file-write-data workdir", sandbox_check(getpid(), "file-write-data", SANDBOX_FILTER_PATH, workdir));
    emitInt("sandbox_check", "mach-lookup opendirectoryd", sandbox_check(getpid(), "mach-lookup", 2, "com.apple.system.opendirectoryd.libinfo"));

    char outside[PATH_MAX];
    snprintf(outside, sizeof outside, "/private/tmp/bunaway-sbx-outside-%d.txt", getpid());
    int rc = tryWrite(outside);
    emitInt("write", "outside-container", rc);
    if (rc == 0) unlink(outside);

    char inside[PATH_MAX];
    snprintf(inside, sizeof inside, "%s/probe-write.txt", workdir);
    rc = tryWrite(inside);
    emitInt("write", "workdir", rc);
    if (rc == 0) unlink(inside);

    // Writes under the (possibly container-remapped) home dir.
    const char* nsHome = [NSHomeDirectory() UTF8String];
    char homeFile[PATH_MAX];
    snprintf(homeFile, sizeof homeFile, "%s/Library/Application Support/bunaway/probe-write.txt", nsHome);
    fs::create_directories(fs::path(homeFile).parent_path());
    rc = tryWrite(homeFile);
    emitInt("write", "nsHome-app-support", rc);
    emitStr("write", "nsHome-app-support-path", homeFile);

    // Outbound TCP to a closed port: ECONNREFUSED means the connect was
    // attempted (network client allowed); EPERM/EACCES means denied.
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(9);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    rc = connect(fd, (struct sockaddr*)&addr, sizeof addr);
    emitInt("net", "connect-127.0.0.1:9", rc == 0 ? 0 : errno);
    if (fd >= 0) close(fd);
    return 0;
}

// posix_spawn <child> with stdin from /dev/null and captured stdout/stderr;
// bounded wait, kill on timeout. Mirrors the host's spawn pattern.
static int spawnChild(const char* child, char* const args[], int timeoutMs) {
    int outPipe[2], errPipe[2];
    if (pipe(outPipe) || pipe(errPipe)) { emitStr("spawn", "pipe", strerror(errno)); return 1; }
    fcntl(outPipe[0], F_SETFL, O_NONBLOCK);
    fcntl(errPipe[0], F_SETFL, O_NONBLOCK);
    int devnull = open("/dev/null", O_RDONLY);

    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_adddup2(&fa, outPipe[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&fa, errPipe[1], STDERR_FILENO);
    posix_spawn_file_actions_addclose(&fa, outPipe[0]);
    posix_spawn_file_actions_addclose(&fa, errPipe[0]);
    posix_spawn_file_actions_addclose(&fa, outPipe[1]);
    posix_spawn_file_actions_addclose(&fa, errPipe[1]);

    pid_t pid = 0;
    int err = posix_spawn(&pid, child, &fa, nullptr, args, environ);
    posix_spawn_file_actions_destroy(&fa);
    close(outPipe[1]); close(errPipe[1]); if (devnull >= 0) close(devnull);
    emitInt("spawn", "posix_spawn", err);
    if (err) { close(outPipe[0]); close(errPipe[0]); return 1; }
    emitInt("spawn", "pid", pid);

    std::string out, errs;
    char buf[8192];
    long waited = 0;
    int status = -1;
    bool done = false;
    while (waited <= timeoutMs) {
        ssize_t n;
        while ((n = read(outPipe[0], buf, sizeof buf)) > 0) out.append(buf, n);
        while ((n = read(errPipe[0], buf, sizeof buf)) > 0) errs.append(buf, n);
        pid_t r = waitpid(pid, &status, WNOHANG);
        if (r == pid) { done = true; break; }
        if (r < 0 && errno == ECHILD) { done = true; break; }
        usleep(50 * 1000);
        waited += 50;
    }
    if (!done) {
        kill(pid, SIGKILL);
        waitpid(pid, &status, 0);
        emitBool("spawn", "timeout-killed", true);
    }
    // drain
    ssize_t n;
    while ((n = read(outPipe[0], buf, sizeof buf)) > 0) out.append(buf, n);
    while ((n = read(errPipe[0], buf, sizeof buf)) > 0) errs.append(buf, n);
    close(outPipe[0]); close(errPipe[0]);
    if (out.size() > 65536) out.resize(65536);
    if (errs.size() > 65536) errs.resize(65536);
    emitStr("spawn", "stdout", out.c_str());
    emitStr("spawn", "stderr", errs.c_str());
    if (WIFEXITED(status)) emitInt("spawn", "exit", WEXITSTATUS(status));
    else if (WIFSIGNALED(status)) emitInt("spawn", "signal", WTERMSIG(status));
    emitBool("spawn", "exited", done);
    return done && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 1;
}

int main(int argc, char** argv) {
    if (argc >= 3 && strcmp(argv[1], "ent") == 0) {
        // probe ent <name>: audit-token entitlement value as the kernel sees
        // it for THIS process (what hasEntitlement returns to XPC services).
        @autoreleasepool {
            SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
            emitBool("ent", "sectask", task != nullptr);
            if (!task) return 1;
            CFErrorRef error = nullptr;
            CFTypeRef value = SecTaskCopyValueForEntitlement(task, (__bridge CFStringRef)[NSString stringWithUTF8String:argv[2]], &error);
            if (value == nullptr) {
                emitStr("ent", argv[2], "<null>");
                if (error) emitStr("ent", "error", [[(__bridge NSError*)error description] UTF8String]);
            } else if (CFGetTypeID(value) == CFBooleanGetTypeID()) {
                emitStr("ent", argv[2], CFBooleanGetValue((CFBooleanRef)value) ? "true" : "false");
            } else {
                emitStr("ent", argv[2], [[(__bridge id)value description] UTF8String]);
            }
            if (value) CFRelease(value);
            CFRelease(task);
        }
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "xpc") == 0) {
        // probe xpc <service-name>: connect to a Mach service and send
        // {"op":"dump"}; the service reports our registered entitlements.
        xpc_connection_t conn = xpc_connection_create_mach_service(argv[2], NULL, 0);
        emitBool("xpc", "conn", conn != nullptr);
        if (!conn) return 1;
        __block bool done = false;
        xpc_connection_set_event_handler(conn, ^(xpc_object_t ev) {
            if (xpc_get_type(ev) == XPC_TYPE_ERROR) {
                const char* d = xpc_dictionary_get_string(ev, XPC_ERROR_KEY_DESCRIPTION);
                emitStr("xpc", "event", d ? d : "error");
                done = true;
            }
        });
        xpc_connection_resume(conn);
        xpc_object_t msg = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(msg, "op", "dump");
        xpc_connection_send_message(conn, msg);
        for (int i = 0; i < 100 && !done; i++) usleep(50 * 1000);
        emitBool("xpc", "closed", done);
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "report") == 0) return report(argv[2]);
    if (argc >= 3 && strcmp(argv[1], "write") == 0) {
        int rc = tryWrite(argv[2]);
        emitInt("write", "path", rc);
        emitStr("write", "path-arg", argv[2]);
        if (rc == 0) unlink(argv[2]);
        return rc ? 1 : 0;
    }
    if (argc >= 3 && strcmp(argv[1], "spawn") == 0) {
        int timeoutMs = 15000;
        int i = 2;
        if (i + 1 < argc && strcmp(argv[i], "--timeout") == 0) { timeoutMs = atoi(argv[i + 1]); i += 2; }
        if (i >= argc) { fprintf(stderr, "usage: probe spawn [--timeout ms] <child> [args]\n"); return 2; }
        return spawnChild(argv[i], &argv[i], timeoutMs);
    }
    fprintf(stderr, "usage: probe report <workdir> | probe write <path> | probe spawn <child> [args]\n");
    return 2;
}
