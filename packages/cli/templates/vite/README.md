# Bunaway + Vite

A starter for Bunaway desktop apps with Vite and TypeScript.

Requires [Bun 1.4.2](https://bun.sh).

## Get started

```sh
bun install
bun run bunaway doctor
bun run bunaway dev
```

Edit `src/` for the UI and `src-bunaway/` for the backend.
`src-bunaway/app.ts` composes the app with `defineApp`;
`src-bunaway/message/module.ts` registers commands and events with `defineModule`.
The framework boots the app from `build.app` in `src-bunaway/bunaway.json`.

Call backend commands from your UI without bridge setup:

```ts
import { invoke } from "@bunaway/client";

const text = await invoke<string>("message.read", null);
```

The SDK connects lazily, waits for the handshake, and closes the connection when
the page exits. Use `listen` for events and its returned disposer for component
cleanup. Backend calls work in the desktop window opened by `bun run bunaway dev`;
a regular browser or Vite preview has no Bunaway bridge.

## Build

```sh
bun run build
bun run bunaway build
```

The first command builds the frontend; the second creates the desktop app in `dist/`.

[Vite](https://vite.dev)
