# Bunaway + Vue + Vite

A starter for Bunaway desktop apps with Vue, Vite and TypeScript.

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
bun run bunaway build
```

The first command builds the frontend; the second creates the desktop app in `dist/`.

[Vite](https://vite.dev)

UI files come from create-vite@9.2.1 (`vue-ts`); see `public/LICENSE.vite.txt`.
Run `bun run typecheck` to check the frontend, backend and Vite configuration.
Vue uses TypeScript 6.0.2 for vue-tsc compiler API compatibility.
