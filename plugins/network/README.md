# Bounded network plugin

Register `networkPlugin` to use `network.request` and `network.exchange` on Windows.
Each operation has an independent permission. Applications own URL access rules in backend commands;
operation grants do not contain resource allowlists. Trusted backend code can use Bun fetch and WebSocket directly.
See the [public contract](../../docs/site/src/content/docs/reference/plugins/network.mdx) for limits and access-rule examples.

HTTP uses Bun fetch with manual redirects, omitted browser credentials and bounded decompressed response reads.
WebSocket exchanges own one connection through close, error, timeout or cancellation. They send bounded text and
receive bounded text/binary messages. Persistent handles are intentionally deferred until session resource
ownership and revocation can be expressed by the public adapter contract.

The existing async host adapter context propagates cancellation and disposal; no host/SDK changes are needed.
`tests/lifecycle/windows-network.test.ts` uses the generated Windows adapter and real loopback HTTP/WebSocket
servers, including redirect refusal, binary preservation, bounds, deadlines, abort and disposal. It runs under
`mise run host:windows` and the cross-platform contract suite using pinned Bun 1.4.2.
These checks do not validate external proxies, OS authentication, TLS certificates or manual network setups.
