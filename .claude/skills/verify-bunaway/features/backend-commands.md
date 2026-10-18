# Backend commands and events

A WebView client negotiates the SDK protocol with the app's backend, calls the commands
`policy.json` grants its view, receives the events it subscribed to, and the backend persists through
host operations. Every template ships the `message` module: `message.save` stores text and
broadcasts `message.saved`, `message.read` returns the stored text.

## Sub-features

- `backend-boot` the backend answers the host's `boot` and `hello` and reports `ready`.
- `backend-channel` a session for a policy view gets a loopback channel URL, and a WebSocket with
  the view's origin negotiates the SDK `hello`.
- `backend-listen` `listen` on `message.saved` returns a subscription id.
- `backend-save` `message.save` requests `storage.writeText` from the host, then emits
  `message.saved` to the subscriber, then returns `null`.
- `backend-read` `message.read` requests `storage.readText` and returns the stored text.
- `backend-shutdown` `shutdown` yields `stopping` and exit code 0.

## How to get to it (user POV)

- Under a real host, the WebView's `createClient()` from `@bunaway/client` does the handshake and
  `client.invoke("message.save", text)` runs the command.
- The host (Windows Bun host, macOS Bun host, Android, iOS) carries the same frames this drive
  sends: `boot`, `hello`, `session-open`, `channel-open`, `web`, `shutdown`.

## Driving it with verify-bunaway

Preconditions:

- A project from [Create a project](./create-project.md) with `doctor` all `OK`.
- `build/verify-bunaway/<run>/evidence` is the evidence directory for this run.

- **Run the drive.** Run `verify-bunaway backend build/verify-bunaway/<run>/app --evidence
  build/verify-bunaway/<run>/evidence`. Exit code `0` and "PASS backend drive".
- **Boot and ready.** In `evidence/backend.json`, `frames` opens with `host->backend boot`,
  `backend->host hello`, `host->backend hello`, `backend->host ready` carrying `bunVersion` 1.4.2.
- **Channel.** After `session-open` and `channel-open` for view `main` and origin
  `https://app.bunaway.local`, `backend->host channel-ready` carries a `ws://127.0.0.1:<port>/<id>`
  URL with the same nonce. Then `sdk->backend hello` and `backend->sdk hello`.
- **Listen and save.** `backend->sdk result` for id `listen-1` carries `subscriptionId`. After
  `sdk->backend invoke message.save`, `backend->host host-request storage.writeText` with the
  template's message path, then `backend->sdk event message.saved` with the saved text and
  `sequence` 1, then `backend->sdk result` for `save-1` with payload `null`.
- **Read.** After `invoke message.read`, `backend->host host-request storage.readText` and
  `backend->sdk result` for `read-1` whose payload equals the saved text. The report's `saved`
  field is that text.
- **Side effect.** `evidence/host-store/` holds one file named after the message path whose content
  is the saved text.
- **Shutdown.** The log ends with `sdk->backend close`, `host->backend shutdown`,
  `backend->host stopping`; `exitCode` is 0 and `stderr` is empty.
- **Proof.** Quote the frames for the step under test, the `host-store` file and `exitCode`.

## Gotchas

- The host operations are answered by the helper's in-process store, not by the storage plugin's
  Windows or macOS implementation. A storage bug in `plugins/storage/src/platforms/` passes here.
- `policy.json` is read from the project, so a command missing from the view's `commands` list
  fails with `PERMISSION_DENIED` in the `result`; that is the policy working, not a drive fault.
- The WebSocket must send the view's origin as `Origin`; the runtime rejects other origins and
  closes the channel.
- The drive writes `<project>/.bunaway-verify/entry.ts`; it is scaffolding and `clean` removes it
  with the project.
- `message.save` emits before it returns, so the event frame precedes the `save-1` result in the
  log. Do not assert on the order between the `host-request` and the event beyond what the frames
  show.
