// Exercise the production router and Win32 file reads without timing-dependent UI races.
#define wmain productHostMain
#include "../../native/windows/host/host.cpp"
#undef wmain

int wmain(int argc, wchar_t** argv) {
    try {
        require(argc == 2, "Expected package path.");
        const fs::path assets = fs::path(argv[1]) / "assets";
        const fs::path testRoot = fs::path(argv[1]).parent_path() / ("host-regression-" + randomHex(8));
        fs::create_directories(testRoot);
        App app;
        app.hostLog = std::make_unique<Log>(testRoot / "host.log", 1024 * 1024);
        app.appLog = std::make_unique<Log>(testRoot / "app.log", 1024 * 1024);
        app.policy = Policy::load(readJson(assets / "policy.schema.json"), assets / "policy.json");
        app.hostCallSchema = readJson(assets / "host-call.schema.json");
        app.hostOps = readJson(assets / "host-operations.json");
        app.runtimeId = "regression";
        app.generation = "1";
        app.backendContext = "backend-test";
        app.viewId = "main";
        app.scopes.temp = testRoot;
        app.scopes.tempCanonical = Scopes::canonicalOf(testRoot);

        // Establish a real message queue; postToWeb uses thread messages when hwnd is null.
        MSG message;
        PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
        const auto context = app.openSession("main", "https://app.bunaway.local/index.html", "https://app.bunaway.local");
        auto request = app.frame("host-request");
        request["context"] = context;
        request["requestId"] = "write-1";
        request["operation"] = "storage.writeText";
        request["payload"] = { { "scope", "temp" }, { "path", "queued.txt" }, { "text", "must not be written" } };
        app.onHostRequest(request);
        app.postToWeb(context, R"({"kind":"result","id":"reused-id"})");
        require(PeekMessageW(&message, nullptr, WM_APP_WEB_MESSAGE, WM_APP_WEB_MESSAGE, PM_REMOVE), "Expected queued delivery.");
        std::unique_ptr<App::WebDelivery> delivery(reinterpret_cast<App::WebDelivery*>(message.lParam));
        require(app.canDeliverWeb(*delivery), "Active-session response was rejected.");

        app.revokeSession("navigation");
        app.openSession("main", "https://app.bunaway.local/page2.html", "https://app.bunaway.local");
        auto task = std::move(app.workQueue.front());
        app.workQueue.pop_front();
        task();
        require(!fs::exists(testRoot / "queued.txt"), "Revoked queued write was executed.");
        require(app.hostPending.empty(), "Revoked host requests were retained.");
        const auto queued = app.queue.size();
        app.hostRespond(context + "|write-1", context, "write-1", { { "kind", "result" }, { "payload", nullptr } });
        require(app.queue.size() == queued, "Revoked host response was sent.");
        require(!app.canDeliverWeb(*delivery), "Previous document received a queued response.");
        std::cout << "PASS revoked queued work and stale UI delivery\n";

        // Even pre-handshake errors belong to one document generation.
        app.revokeSession("navigation");
        app.webError("bad-id", "INVALID_ARGUMENT", "Bad request.");
        require(PeekMessageW(&message, nullptr, WM_APP_WEB_MESSAGE, WM_APP_WEB_MESSAGE, PM_REMOVE), "Expected queued error.");
        delivery.reset(reinterpret_cast<App::WebDelivery*>(message.lParam));
        require(app.canDeliverWeb(*delivery), "Current document error was rejected.");
        app.revokeSession("navigation");
        require(!app.canDeliverWeb(*delivery), "Pre-session error crossed documents.");
        std::cout << "PASS pre-session error document generation\n";

        // Force truncation after measuring size, before the production read loop.
        const auto path = testRoot / "shrinking.txt";
        { std::ofstream out(path); out << "original contents"; }
        Handle reader(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
        require(reader.value != INVALID_HANDLE_VALUE, "Read handle failed.");
        LARGE_INTEGER size;
        require(GetFileSizeEx(reader.value, &size), "File size failed.");
        { std::ofstream truncate(path, std::ios::trunc); truncate << "short"; }
        bool rejected = false;
        try { readStorageText(reader.value, static_cast<size_t>(size.QuadPart)); }
        catch (const std::runtime_error&) { rejected = true; }
        require(rejected, "Truncated file was accepted.");
        LARGE_INTEGER zero {};
        require(SetFilePointerEx(reader.value, zero, nullptr, FILE_BEGIN), "File rewind failed.");
        require(readStorageText(reader.value, 5) == "short", "Ordinary read failed.");
        require(readStorageText(reader.value, 0).empty(), "Empty read failed.");
        std::cout << "PASS early EOF terminates; normal and empty reads succeed\n";

        const auto readContext = app.openSession("main", "https://app.bunaway.local/index.html", "https://app.bunaway.local");
        auto readOutcome = [&](const std::string& text) {
            { std::ofstream out(testRoot / "response.txt", std::ios::binary); out << text; }
            app.queue.clear();
            auto read = app.frame("host-request");
            read["context"] = readContext;
            read["requestId"] = "read-response";
            read["operation"] = "storage.readText";
            read["payload"] = { { "scope", "temp" }, { "path", "response.txt" } };
            app.onHostRequest(read);
            auto readTask = std::move(app.workQueue.front());
            app.workQueue.pop_front();
            readTask();
            require(app.queue.size() == 1, "Storage read must send exactly one outcome.");
            require(app.hostPending.empty(), "Completed read retained its pending record.");
            const auto response = parse(app.queue.front().substr(0, app.queue.front().size() - 1));
            require(response["context"] == readContext && response["requestId"] == "read-response", "Read response correlation changed.");
            return response["payload"];
        };
        for (const auto& text : { std::string(maxFrame, 'a'), std::string(200000, '\x01') }) {
            auto outcome = readOutcome(text);
            require(outcome["kind"] == "error" && outcome["error"]["code"] == "INTERNAL", "Oversized serialized read must return an error.");
        }
        auto outcome = readOutcome("ordinary read");
        require(outcome["kind"] == "result" && outcome["payload"] == "ordinary read", "Normal read failed after oversized responses.");
        std::cout << "PASS oversized and escaped reads return errors; normal reads recover\n";

        app.messageSchema = readJson(assets / "message.schema.json");
        app.ready = true;
        app.sessions.at(readContext).negotiated = true;
        auto receive = [&] {
            require(PeekMessageW(&message, nullptr, WM_APP_WEB_MESSAGE, WM_APP_WEB_MESSAGE, PM_REMOVE), "Expected Web response.");
            std::unique_ptr<App::WebDelivery> response(reinterpret_cast<App::WebDelivery*>(message.lParam));
            require(app.canDeliverWeb(*response), "Response destination is inactive.");
            return parse(utf8(response->text));
        };
        auto submit = [&](const Json& web) {
            app.onWebMessage(L"https://app.bunaway.local/index.html", "https://app.bunaway.local/index.html", web.dump());
        };
        Json invoke = { { "kind", "invoke" }, { "protocol", ipc }, { "id", "boundary" }, { "command", "test.echo" }, { "payload", "" } };
        invoke["payload"] = std::string(maxFrame - invoke.dump().size(), 'a');
        Json nested = nullptr;
        for (size_t i = 0; i < maxDepth - 1; ++i) nested = Json::array({ nested });
        auto deep = invoke;
        deep["payload"] = nested;
        for (const auto& rejectedFrame : { invoke, deep }) {
            app.queue.clear();
            require(valid(app.messageSchema, parse(rejectedFrame.dump())), "Fixture must be valid Web IPC.");
            submit(rejectedFrame);
            auto response = receive();
            require(response["kind"] == "error" && response["error"]["code"] == "INVALID_ARGUMENT", "Envelope overflow must return INVALID_ARGUMENT.");
            require(app.queue.empty(), "Invalid internal frame reached backend.");
            require(app.sessions.at(readContext).pending.empty() && app.sessions.at(readContext).usedIds.empty(), "Rejected frame reserved request state.");
        }
        // The same ID remains usable, and the deepest allowed internal frame is sent.
        deep["payload"] = nested.at(0);
        submit(deep);
        require(app.queue.size() == 1, "Valid boundary frame was not sent.");
        parse(app.queue.front());
        app.onBackendWeb(readContext, { { "kind", "result" }, { "protocol", ipc }, { "id", "boundary" }, { "payload", "ok" } });
        require(receive()["payload"] == "ok", "Session did not recover after rejected frames.");
        std::cout << "PASS internal envelope size/depth rejection preserves session and request IDs\n";

        // A response must lose to its deadline even before the UI timer runs.
        for (const auto& kind : { "result", "error" }) {
            app.queue.clear();
            app.sessions.at(readContext).pending["expired"] = { "invoke", GetTickCount64() - 1 };
            Json response = { { "kind", kind }, { "protocol", ipc }, { "id", "expired" } };
            if (std::string(kind) == "result") response["payload"] = "late success";
            else response["error"] = { { "code", "INTERNAL" }, { "message", "late error" } };
            app.onBackendWeb(readContext, response);
            require(receive()["error"]["code"] == "TIMEOUT", "Expired response was delivered instead of TIMEOUT.");
            require(app.sessions.at(readContext).pending.empty(), "Expired request retained pending state.");
            require(app.queue.size() == 1 && parse(app.queue.front())["payload"]["kind"] == "cancel", "Expired request must cancel backend work.");
            app.onBackendWeb(readContext, response);
            app.scanDeadlines();
            require(!PeekMessageW(&message, nullptr, WM_APP_WEB_MESSAGE, WM_APP_WEB_MESSAGE, PM_NOREMOVE), "Expired request completed more than once.");
        }
        std::cout << "PASS expired backend success/error produce exactly one TIMEOUT before timer\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
