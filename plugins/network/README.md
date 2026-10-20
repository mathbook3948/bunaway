# Bounded network plugin

Register `network` to use `network.request`, `network.exchange`, `network.isOnline` and `network.resolveHost` on Windows and macOS, and `network.resolveProxy` on Windows.
Each operation has an independent permission. Applications own URL access rules in backend commands;
operation grants do not contain resource allowlists. Trusted backend code can use Bun fetch and WebSocket directly.
See the [public contract](../../docs/site/src/content/docs/reference/plugins/network.mdx) for limits and access-rule examples.

`network.isOnline` corresponds to Electron's `net.isOnline()` (whether an active connection exists). It is true when an
operational interface holds an address that is neither loopback nor link-local; virtual adapters count, and captive
portals and internet reachability are not checked. On Windows the plugin also publishes `network.onlineChanged` when
that value changes, found by comparing it every 2 seconds. macOS does not publish the event.

`network.resolveHost` corresponds to Electron's `net.resolveHost()`. It returns `{ endpoints: [{ address, family }] }` from
the system resolver (getaddrinfo), so the hosts file and system DNS settings apply. It takes an ASCII host name or IPv4
address, keeps resolver order, removes repeats and returns at most 64 addresses. Cancellation and the deadline end the
call at once while an already started lookup finishes in the background. `queryType` ("A" or "AAAA") keeps only IPv4 or IPv6 addresses; the family is requested from the resolver directly, a name without that family fails like an unknown name, and an IPv4 literal asked for "AAAA" gives an empty list. The `source`, cache and secure DNS options are not provided.

`network.resolveProxy` corresponds to Electron's `session.resolveProxy(url)` on Windows (macOS reports `UNSUPPORTED`). It
returns `{ entries }`, a structured list of `{ kind: "direct" }` and `{ kind: "proxy", scheme, host, port }` instead of a
PAC string. It reads the current user's Internet Options through WinHTTP: loopback and link-local hosts go direct, then
automatic detection, the configured script and the manual proxy list with its bypass list apply. Proxy credentials are
never returned. Automatic detection and script lookups block inside WinHTTP, so they run in a worker thread:
cancellation and the deadline end the caller's wait at once, a lookup already inside WinHTTP holds one of four worker
slots until the call returns (so its handles are closed), and `BUSY` is reported beyond that. It does not change how `network.request` connects.

HTTP uses Bun fetch with manual redirects, omitted browser credentials and bounded decompressed response reads.
WebSocket exchanges own one connection through close, error, timeout or cancellation. They send bounded text and
receive bounded text/binary messages. Persistent handles are intentionally deferred until session resource
ownership and revocation can be expressed by the public adapter contract.

The existing async host adapter context propagates cancellation and disposal; no host/SDK changes are needed.
`tests/lifecycle/windows-network.test.ts` uses both generated Windows and macOS adapters and real loopback HTTP/WebSocket
servers, including redirect refusal, binary preservation, bounds, deadlines, abort and disposal. It runs under
`mise run host:windows` and the cross-platform contract suite using pinned Bun 1.4.2.
`tests/lifecycle/macos-network.ts` runs the compiled WKWebView, SDK, Core and async host adapter
against real loopback servers under `mise run host:macos`. It checks view and backend grants,
HTTP bytes and redirects, WebSocket text and binary, malformed handshakes, bounds, deadlines,
client cancellation, continued UI responses and shutdown with requests in flight.
`tests/cli/network.test.ts` installs the packed plugin with isolated dependencies and checks both
native exports and exclusion of Bun network implementation from the browser bundle.
These checks do not validate external proxies, OS authentication, TLS certificates or manual network setups.
