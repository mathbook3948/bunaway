# Store plugin

`@bunaway/plugin-store` keeps named JSON key-value stores in `<dataRoot>/data/stores/<name>.json`
on Windows and macOS. Callers pass a store name, never a path. Register `store` in the app
definition. Each operation requires its own permission; registration grants none.

- `src/contract.ts` declares the schemas, the named limits and the `StoreInstance` interface.
- `src/platforms/node-store.ts` is the one implementation both platforms register. It uses only
  `node:fs`, saves through a temporary file and a retried rename, and owns one debounce timer per
  open store. `dispose` stops the timers and saves unsaved stores.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/store.mdx) for inputs,
results, limits and failures. `tests/api/store.test.ts` covers the contract with real temporary
directories and an injected rename for the retry policy.

Not provided: a change event pushed to the WebView (the I/O worker adapter has no event service),
per-store-name permission lists, encryption and migrations.
