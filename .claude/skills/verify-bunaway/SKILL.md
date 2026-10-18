---
name: verify-bunaway
description: "Drive a generated bunaway app the way its developer and its native host do, and capture proof: the packed CLI creates and validates a project, the backend runs under the host process protocol with a real SDK channel, and a template's web dev server answers. Works on Linux, macOS and Windows with Bun alone; native window hosts need the OS-specific runners. Use when a change touches the CLI, templates, Core, the Bun runtime, the SDK protocol or a plugin's contract and you need evidence beyond unit tests."
---

# Verify bunaway

bunaway is a framework. Its user is an app developer who runs the CLI, writes backend commands and
calls them from a WebView through the SDK. This skill drives exactly those surfaces with the real
packed framework, from any checkout that has `bun install` done. Everything it starts is yours to
stop; it never attaches to an instance it did not start.

Helper: `bun .claude/skills/verify-bunaway/scripts/verify-bunaway.ts <command> <dir> [options]`.
Every example below writes under `build/verify-bunaway/` (gitignored). Use one run id per attempt
so parallel runs never share a project or an evidence directory.

## What this can and cannot prove

- **Proves on any OS:** the packed CLI creates, installs and validates a project; the app's backend
  boots under the host process protocol, grants a loopback SDK channel, enforces `policy.json`,
  runs commands, emits events and shuts down cleanly; a Vite-family template's dev server serves the
  page with the Vite client and the CSP the CLI injects.
- **Does not prove:** native plugin implementations (`plugins/*/src/platforms/`), windows, WebView
  behavior, packaging. The backend drive answers host operations (`storage.*`, `log.write`) from an
  in-process store that stands in for the host. Those run only under the real hosts: `mise run
  host:windows` on Windows x64 and `mise run host:macos` on macOS arm64, which execute
  `tests/lifecycle/run-native.ts`. See `features/native-hosts.md`.

## Launch

```sh
RUN=verify-$(date +%s)
bun .claude/skills/verify-bunaway/scripts/verify-bunaway.ts pack build/verify-bunaway/$RUN/packages
bun .claude/skills/verify-bunaway/scripts/verify-bunaway.ts create build/verify-bunaway/$RUN/app \
  --packages build/verify-bunaway/$RUN/packages --template vanilla
```

- `pack` runs `bun run framework:pack --local` (about 20 s on a warm checkout). It needs
  `bun run plugins:build` output, which `mise run test` and the pack script produce.
- `create` extracts the packed CLI once into the OS temp directory (outside any `node_modules`
  ancestor, so Bun auto-installs the CLI's esbuild dependency on first run, which needs network
  once), runs its `create` with `--package-dir`, then `bun install` inside the project. Ready means
  `doctor` passes below.
- Templates: `vanilla` (static UI, backend only), `vite`, `react`, `vue`, `svelte` (add a web dev
  server). The backend drive works on every template because they all ship the `message` module.

## Doctor

```sh
bun .claude/skills/verify-bunaway/scripts/verify-bunaway.ts doctor build/verify-bunaway/$RUN/app
```

Read-only. Prints one `OK` or `FAIL` line each for the Bun version (1.4.2), the project settings
file, the installed `@bunaway/runtime-bun`, and `bun run validate` (expects "Configuration and
policy are valid."). Any `FAIL` means the project is not worth driving; recreate it. The CLI's own
`bunaway doctor` reports `FAIL target` on Linux because only Windows x64 and macOS arm64 build
native apps; that is expected and not a project fault.

## Drive

- **Backend over the process protocol.** `backend <project> --evidence <dir>` writes
  `<project>/.bunaway-verify/entry.ts` (the host bundler's role), spawns it with `bun --no-env-file`,
  and plays the host: `boot` with the project's `policy.json`, `hello`, waits for `ready`, opens a
  session for the first view, requests a channel with that view's first origin, connects a WebSocket
  with the same `Origin`, sends the SDK `hello`, subscribes to `message.saved`, invokes
  `message.save` with a timestamped text, waits for the event, invokes `message.read`, expects the
  same text back, then `close` and `shutdown` and expects `stopping` with exit code 0. Host
  operation requests the commands make are answered from the in-process store.
- **Web dev server.** `web <project> --evidence <dir>` reads `dev.command` from
  `src-bunaway/bunaway.json`, starts it on a free port, polls the page for up to 30 s and requires
  `src="/@vite/client"` in the HTML. The vanilla template has no dev server; the command says so.
- **Native hosts.** Not driven here. `features/native-hosts.md` names the commands and the result
  files the OS runners write.

Each step bounds its waits (10 s per protocol step, 30 s for the first web response, 5 min for
pack and install). A step that times out names what it waited for.

## Evidence

- `backend.json`: `pass`, `exitCode`, the saved text, the `message.saved` event as delivered, the
  subscription id, the host store contents, the backend's stderr, and `frames`, the complete ordered
  exchange in four directions (`host->backend`, `backend->host`, `sdk->backend`, `backend->sdk`).
- `host-store/<path>`: the text each `storage.writeText` stored, one file per path, so the side
  effect of `message.save` is visible outside the protocol log.
- `web.json`: `pass`, the URL, the served HTML and the dev server's stderr.

Proof standard: the drive goes through the real SDK wire protocol and the real `policy.json`, never
through Core's internal API. A proof names the feature file and the run id, quotes the relevant
`frames` entries, and shows the host store file. A `pass` without the matching `frames` lines is not
a proof. Keep evidence outside the project directory so `clean` cannot remove it.

## Cleanup

```sh
bun .claude/skills/verify-bunaway/scripts/verify-bunaway.ts clean build/verify-bunaway/$RUN/app
```

Removes only the project directory. The backend child and the dev server are killed by the step
that started them, even when the step fails. The packages directory and every evidence directory
stay; delete `build/verify-bunaway/$RUN/packages` yourself when the run is over. Never kill Bun
processes by name; the helper owns its children.

## Feature map

`features/README.md` is the index. One file per user-facing feature says how a user reaches it,
how to drive it with this helper, and what observable end state proves it. A proof that drives one
convenient entry point is incomplete when the map lists others. Keep the map honest with
`/maintain-verification-skill` when templates, commands or the protocol change.
