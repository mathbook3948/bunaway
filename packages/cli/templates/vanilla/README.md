# Bunaway + Vanilla TS

A starter for Bunaway desktop apps with HTML, CSS, and TypeScript.

Requires [Bun 1.4.2](https://bun.sh).

## Get started

```sh
bun install
bun run doctor
bun run dev
```

Edit `src/` for the UI and `src-bunaway/` for the backend.
`src-bunaway/app.ts` composes the app with `defineApp`;
`src-bunaway/message/module.ts` registers commands and events with `defineModule`.
The framework boots the app from `build.app` in `src-bunaway/bunaway.json`.

Call backend commands directly from the UI:

```ts
import { invoke } from "@bunaway/client";

const text = await invoke<string>("message.read", null);
```

Use `invoke` and `listen` without initialization code. Call the disposer returned
by `listen` when the UI component is removed. Backend calls work in the desktop
app; calls from a regular browser fail with `UNSUPPORTED`.

Backend commands and their services can import `storage`, `log`, and `capabilities`
from `@bunaway/backend` directly. The SDK uses the current command's Host permissions
and cancellation signal, without passing `context.host` through service arguments.
Await Host operations before the command returns. Calls outside an execution context
or after command completion are rejected. The starter allows storage under `appData/messages`;
logging requires enabling `host.log` for the calling view in `policy.json`.

## Build

```sh
bun run build
```

The desktop app is written to `dist/`.
