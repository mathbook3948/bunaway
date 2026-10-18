---
name: native-change-verification
description: Checklist for changes to Windows or macOS platform code in native/ or plugins/*/src/platforms. Use before opening or updating a PR that touches FFI bindings, COM or Objective-C objects, window or process handles, native event subscriptions, or the documentation of such behavior.
---

# Native change verification

Run through every section before you report a native change as done. Each item names the
shared implementation to use instead of writing the policy again; reviews of past PRs
repeatedly asked for exactly these fixes.

## 1. Resource lifetime

- Every `dlopen` handle, HWND, COM object, Job handle, registration and timer has one owner
  that releases it on success, failure and cancellation. Prefer `ResourceOwner` from
  `@bunaway/plugin` when resources are acquired in sequence; it releases in reverse order and
  rolls back a half-finished initialize.
- Cleanup attempts every release even when one fails and reports them together:
  `attemptAll` or `attemptAllAsync` with a message naming the owner. Do not stop at the first
  failure and do not swallow the rest.
- Work that fails after acquiring something cleans up before rethrowing: `failWithCleanup`.
- A library handle stays open for as long as any native object obtained through it can still
  be released (for example shell32 while a shell item is alive).
- `dispose` is safe to call twice and later callbacks from native code are ignored after it.

## 2. FFI signatures and buffers

- Compose Win32 symbol tables from `@bunaway/plugin/win32` (`pick(KERNEL32, ...)`, `OLE32`,
  `USER32`, `SHELL32`, `COMBASE`, `ADVAPI32`). Declare a signature locally only when the
  shared table lacks it, and add it there when a second plugin needs it.
- Handles are `u64`, pointers `ptr`, BOOL results `i32`, HRESULTs `i32`. Do not mix
  conventions inside one table. `tests/conformance/ffi-signatures.test.ts` fails when a symbol
  gains a second signature anywhere in the repository; its known-conflict list only shrinks.
- Pass strings through `wide`, `withWide` or `withBuffer` so the buffer outlives the call.
- Check HRESULTs with `checkHresult` or the plugin's own error mapping; never ignore a
  negative result.

## 3. Threads and apartments

- State which thread the code runs on (UI STA, I/O Worker) and that every COM call happens
  on the thread that initialized its apartment. Pair `CoInitializeEx` with `CoUninitialize`
  on the same thread, once.
- Nothing heavy runs inside a native callback: no cleanup, no awaiting, no reentrant plugin
  operations. Post work back to the owning loop.

## 4. Bounds and validation

- Declare input limits in the contract with shared schemas: `int32Schema`,
  `nonNegativeInt32Schema`, `base64Schema(maxBytes)`. Name every other limit with a
  `MAX_*` or `MIN_*` constant next to the contract that owns it.
- Clamp or reject before touching native code, and reject with `INVALID_ARGUMENT`;
  `UNSUPPORTED` comes first when the platform cannot do the operation at all.
- Paths from the application are validated for the platform (length, reparse points,
  reserved names, surrogates) before any handle is opened.

## 5. Cancellation, ordering and concurrency

- `AbortSignal` reaches every wait and child process; a cancelled operation releases its
  capacity immediately and drops a late result instead of applying it.
- Overlapping requests are either serialized or rejected; say which, and bound how many may
  be in flight.
- Do not promise ordering between independent events in code or docs unless a test proves it.

## 6. Distribution

- A new file under `native/windows/bun`, `native/macos/bun`, `native/host-api/bun` or `native/ios`
  is added to `frameworkPaths` in `packages/cli/src/distribution.ts`, or the installed framework
  cannot build apps. `tests/cli/framework-paths.test.ts` fails until it is listed, and fails again
  when a listed entry disappears.
- Code that a WebView bundle can reach (plugin `src/*.ts`, the neutral SDK modules) uses no
  `Buffer`, `Bun`, `process` or `node:` module; Bun-only implementation lives in `src/platforms/`.
  The lint override and `tests/conformance/browser-boundary.test.ts` enforce it.
- A new `@bunaway/plugin` export reaches built plugins automatically; a new SDK subpath
  export needs a `package.json` exports entry and a reference-map entry.

## 7. Tests

- Add the contract test under `tests/api/` for every new input rule and error code.
- Platform tests use `test.skipIf(process.platform !== "win32")` or the macOS equivalent,
  run real native code, and assert on observed state, not on timing. No vacuous tests.
- Destructive or environment-changing checks run only under a CI condition.
- Pick the checks from the table in `tests/README.md` and run them on the platform the change
  targets. Report what ran and what could not run here.

## 8. Documentation

- Document only what the tests verified. Narrow claims about ordering, coalescing and platform
  coverage to the verified cases.
- Update the reference page, `docs/site/src/reference-map.json` for new public names, and the
  platform support table when support changes. Run `bun run docs:check` and `bun run docs:build`.
- No em dashes or middle dots in text; `bun test tests/docs` checks this.
