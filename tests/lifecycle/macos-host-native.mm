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
        fs::path testRoot;
        try {
            require(argc == 2, "Expected workspace path.");
            testRoot = fs::path(argv[1]) / ("host-security-" + randomHex(8));
            fs::create_directories(testRoot / "web");
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
