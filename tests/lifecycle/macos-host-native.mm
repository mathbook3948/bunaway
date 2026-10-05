// Exercise the production file and URL boundaries without WebView timing races.
#define main productHostMain
#include "../../native/macos/host/main.mm"
#undef main

@interface BWTestSchemeTask : NSObject <WKURLSchemeTask>
@property(nonatomic, strong) NSURLRequest* request;
@property(nonatomic) NSInteger status;
@property(nonatomic) BOOL finished;
@end
@implementation BWTestSchemeTask
- (void)didReceiveResponse:(NSURLResponse*)response { self.status = [(NSHTTPURLResponse*)response statusCode]; }
- (void)didReceiveData:(NSData*)data {}
- (void)didFinish { self.finished = YES; }
- (void)didFailWithError:(NSError*)error { self.status = -1; self.finished = YES; }
@end

int main(int argc, char** argv) {
    @autoreleasepool {
        if (argc == 3 && std::string(argv[1]) == "--guard") return guard(argv[2]);
        fs::path testRoot;
        try {
            require(argc == 3, "Expected workspace and package paths.");
            testRoot = fs::absolute(fs::path(argv[1])) / ("host-security-" + randomHex(8));
            fs::create_directories(testRoot / "web");
            {
                const auto originalBun = fs::path(argv[2]) / "runtime/bun";
                const auto signedBun = testRoot / "bun";
                fs::copy_file(originalBun, signedBun);
                App runtime;
                const auto upstream = sha256(originalBun);
                runtime.manifest = { { "bun", { { "executableSha256", upstream } } } };
                runtime.verifyBun(signedBun);
                std::vector<std::string> args = { "/usr/bin/codesign", "--force", "--sign", "-",
                    "--identifier", "tests.bunaway.resigned", signedBun.string() };
                std::vector<char*> signArgv;
                for (auto& arg : args) signArgv.push_back(arg.data());
                signArgv.push_back(nullptr);
                char path[] = "PATH=/usr/bin:/bin";
                char* env[] = { path, nullptr };
                pid_t signer;
                require(posix_spawn(&signer, args[0].c_str(), nullptr, nullptr, signArgv.data(), env) == 0, "codesign spawn failed.");
                int status = 0;
                require(waitpid(signer, &status, 0) == signer && WIFEXITED(status) && WEXITSTATUS(status) == 0, "codesign failed.");
                const auto packaged = sha256(signedBun);
                require(packaged != upstream, "Re-signing must change Bun bytes.");
                runtime.manifest["bun"]["packagedSha256"] = packaged;
                runtime.verifyBun(signedBun);
                runtime.assets = testRoot;
                runtime.scopes.dataRoot = testRoot;
                runtime.scopes.temp = testRoot;
                runtime.hostLog = std::make_unique<Log>(testRoot / "runtime.log", 1024 * 1024);
                { std::ofstream out(testRoot / "backend.js"); out << "console.log('signed-runtime-ok');"; }
                { std::ofstream out(testRoot / "bunfig.toml"); }
                { std::ofstream out(testRoot / "tsconfig.json"); out << "{}"; }
                runtime.spawnBun(signedBun);
                std::string output;
                readLines(runtime.output.value, [&](const std::string& line) { output += line; });
                require(waitpid(runtime.childPid, &status, 0) == runtime.childPid, "Bun wait failed.");
                runtime.deathWrite.reset();
                int guardStatus = 0;
                require(waitpid(runtime.guardPid, &guardStatus, 0) == runtime.guardPid, "Guard wait failed.");
                require(WIFEXITED(status) && WEXITSTATUS(status) == 0 && output == "signed-runtime-ok", "Re-signed Bun failed to run.");
                for (const auto& digest : { Json(upstream), Json(""), Json(nullptr) }) {
                    runtime.manifest["bun"]["packagedSha256"] = digest;
                    bool denied = false;
                    try { runtime.verifyBun(signedBun); } catch (...) { denied = true; }
                    require(denied, "Invalid packaged digest must fail preflight.");
                    denied = false;
                    runtime.childPid = 0;
                    try { runtime.spawnBun(signedBun); } catch (...) { denied = true; }
                    require(denied && runtime.childPid == 0, "Invalid packaged digest must fail before spawn.");
                }
                runtime.manifest["bun"]["executableSha256"] = packaged;
                runtime.manifest["bun"]["packagedSha256"] = upstream;
                bool denied = false;
                try { runtime.verifyBun(signedBun); } catch (...) { denied = true; }
                require(denied, "A matching upstream digest cannot override a wrong packaged digest.");
                runtime.manifest["bun"].erase("packagedSha256");
                runtime.verifyBun(signedBun);
                require(sha256(originalBun) == upstream, "Original bundled Bun was mutated.");
                std::puts("PASS re-signed Bun preflight, spawn, digest precedence and unsigned fallback");
            }
            Scopes scopes;
            scopes.temp = testRoot;
            scopes.tempCanonical = Scopes::canonicalOf(testRoot);
            require(mkfifo((testRoot / "pipe").c_str(), 0600) == 0, "FIFO creation failed.");
            for (bool write : { false, true }) {
                bool denied = false;
                try { openScopedFile(scopes, "temp", { "pipe" }, write); }
                catch (const HostError& error) { denied = error.code == "PERMISSION_DENIED"; }
                require(denied, "FIFO must be denied without waiting for a peer.");
            }
            {
                Fd peer(open((testRoot / "pipe").c_str(), O_RDONLY | O_NONBLOCK));
                require(peer.value >= 0, "FIFO peer open failed.");
                bool denied = false;
                try { openScopedFile(scopes, "temp", { "pipe" }, true); }
                catch (const HostError& error) { denied = error.code == "PERMISSION_DENIED"; }
                require(denied, "FIFO must also be denied when open succeeds.");
            }
            {
                auto file = openScopedFile(scopes, "temp", { "ordinary.txt" }, true);
                require(write(file.value, "hello", 5) == 5, "Regular-file write failed.");
            }
            {
                auto file = openScopedFile(scopes, "temp", { "ordinary.txt" }, false);
                require(readStorageText(file.value, 5) == "hello", "Regular-file read failed after FIFO rejection.");
            }
            std::puts("PASS FIFO read/write rejection and regular-file recovery");

            App app;
            app.assets = testRoot;
            app.viewId = "main";
            { std::ofstream out(testRoot / "web/index.html"); out << "asset"; }
            g_app = &app;
            BWSchemeHandler* handler = [[BWSchemeHandler alloc] init];
            auto check = [&](const std::string& uri, NSInteger expected) {
                BWTestSchemeTask* task = [[BWTestSchemeTask alloc] init];
                task.request = [NSURLRequest requestWithURL:[NSURL URLWithString:nsstr(uri)]];
                [handler webView:nil startURLSchemeTask:task];
                require(task.finished && task.status == expected, "Scheme handler accepted or denied the wrong origin.");
            };
            app.policy.views["main"].origins = { "https://app.bunaway.local" };
            check("bunaway://app.bunaway.local/index.html", 200);
            check("bunaway://app.bunaway.local:443/index.html", 200);
            check("bunaway://app.bunaway.local:8443/index.html", 403);
            check("bunaway://user@app.bunaway.local/index.html", 403);
            check("bunaway://user:pass@app.bunaway.local/index.html", 403);
            check("bunaway://other.bunaway.local/index.html", 403);
            check("https://app.bunaway.local/index.html", 403);
            check("http://app.bunaway.local/index.html", 403);
            app.policy.views["main"].origins = { "https://app.bunaway.local:8443" };
            check("bunaway://app.bunaway.local:8443/index.html", 200);
            check("bunaway://app.bunaway.local/index.html", 403);
            check("bunaway://app.bunaway.local:8444/index.html", 403);
            check("bunaway://user@app.bunaway.local:8443/index.html", 403);
            g_app = nullptr;
            std::puts("PASS scheme handler preserves ports and rejects userinfo");

            auto rules = resourceRules({ "https://app.bunaway.local", "http://127.0.0.1:12345" });
            auto allowed = [&](const std::string& uri) {
                bool blocked = false;
                for (const auto& rule : rules) {
                    auto filter = rule["trigger"]["url-filter"].get<std::string>();
                    if (std::regex_search(uri, std::regex(filter, std::regex::icase)))
                        blocked = rule["action"]["type"] == "block";
                }
                return !blocked;
            };
            for (const auto& uri : { "https://app.bunaway.local", "https://app.bunaway.local/a.js",
                    "https://APP.bunaway.local:443/a.js", "http://127.0.0.1:12345/image.svg" })
                require(allowed(uri), "Declared resource origin was blocked.");
            for (const auto& uri : { "https://other.local/a.js", "https://sub.app.bunaway.local/a.js",
                    "https://app.bunaway.local.evil/a.js", "http://app.bunaway.local/a.js",
                    "https://app.bunaway.local:8443/a.js", "http://127.0.0.1:12346/image.svg",
                    "https://user@app.bunaway.local/a.js" })
                require(!allowed(uri), "Undeclared resource origin was allowed.");
            std::puts("PASS resource filters match exact scheme, host and port");
            fs::remove_all(testRoot);
            return 0;
        } catch (const std::exception& error) {
            g_app = nullptr;
            if (!testRoot.empty()) fs::remove_all(testRoot);
            std::fprintf(stderr, "%s\n", error.what());
            return 1;
        }
    }
}
