# Bounded network plugin

Register `network` to use `network.request`, `network.exchange` and `network.isOnline` on Windows and macOS.
Each operation has an independent permission.

`network.isOnline` corresponds to Electron's `net.isOnline()` (whether an active connection exists). It is true when an
operational interface holds an address that is neither loopback nor link-local; virtual adapters count, and captive
portals and internet reachability are not checked. On Windows the plugin also publishes `network.onlineChanged` when
that value changes, found by comparing it every 2 seconds. macOS does not publish the event.
 Applications own URL access rules in backend commands;
operation grants do not contain resource allowlists. Trusted backend code can use Bun fetch and WebSocket directly.
See the [public contract](../../docs/site/src/content/docs/reference/plugins/network.mdx) for limits and access-rule examples.

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
