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

The SDK connects to the app WebView, waits for the handshake, and closes the
connection when the page exits. Use `listen` to subscribe to events and call its
returned disposer when the UI component is removed. Backend calls require the
desktop app; a regular browser has no Bunaway bridge.

## Build

```sh
bun run build
```

The desktop app is written to `dist/`.
