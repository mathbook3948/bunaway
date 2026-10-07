# Bunaway + React + Vite

A starter for Bunaway desktop apps with React, Vite and TypeScript.

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

## Backend calls

The example below infers command and event types from the app definition:

```ts
import type { CommandsOf, EventsOf } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
import type { app } from "../src-bunaway/app.ts";

async function start(): Promise<void> {
  const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
  const text = await client.invoke("message.read", null);
  console.log(text);
}

void start().catch(console.error);
```

The example creates the client in a startup function to handle creation and call
failures. You can reuse it in components and event handlers. Dispose each
component's `client.listen` subscriptions on cleanup, keeping the shared client
open. Backend calls through the default connection require the desktop WebView.

## Backend Host operations

Backend commands and their services can import `storage`, `log`, and `capabilities`
from `@bunaway/backend` directly. The SDK uses the current command's Host permissions
and cancellation signal, without passing `context.host` through service arguments.
Await Host operations before the command returns. Calls outside an execution context
or after command completion are rejected. The starter allows storage under `appData/messages`;
logging requires enabling `host.log` for the calling view in `policy.json`.

## Build

```sh
bun run build
# Build and package for Windows:
bun run package win-direct --build
```

`bun run build` runs the web build configured in `build.command`, validates its output,
and creates the desktop app in `dist/`. It runs the web build every time, including
when `web-dist/` already exists. A web build failure stops the app build.
`package --build` uses the same full build before packaging.

Use `bun run dev:web` for the web server alone and `bun run build:web` for web assets alone.
`bun run validate` checks existing assets without running the web build.
`bun run package win-direct` packages an existing app artifact without rebuilding.

[Vite](https://vite.dev)

UI files come from create-vite@9.2.1 (`react-ts`); see `public/LICENSE.vite.txt`.
Run `bun run typecheck` to check the frontend, backend and Vite configuration.
React Fast Refresh allows inline scripts only in development; production uses `script-src 'self'`.
