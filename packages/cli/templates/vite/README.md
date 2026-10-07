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

The client can be reused for commands and subscriptions in event handlers and
components. The startup function handles creation and call failures. Call the disposer
returned by `client.listen` when the UI component is removed, keeping the shared
client open. Backend calls work in the desktop
window opened by `bun run bunaway dev`; calls from a regular browser or Vite
preview fail with `UNSUPPORTED`.

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
