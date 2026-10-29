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

`store.changed` goes to views through the event service of the I/O Worker, once per change that alters
the contents, with `{ name, kind, key? }` and never the value. It needs the view to allow and subscribe
to the event and to hold `store.keys`. It is raised on Windows only; the macOS adapter runs without the event service and changes silently.

Not provided: per-store-name permission lists, encryption and migrations.
