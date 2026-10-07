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

All Bunaway UIs use a client typed from the app definition. Create it during
WebView UI initialization and reuse it for commands and event subscriptions:

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

Call `client.invoke` and `client.listen` from event handlers and components.
Handle client creation and call failures during initialization. Call the disposer
returned by `client.listen` when the UI component is removed, keeping the shared
client open. Backend calls work in the desktop
window opened by `bun run bunaway dev`; calls from a regular browser or Vite
preview fail with `UNSUPPORTED`.

## Build

```sh
bun run build
bun run bunaway build
```

The first command builds the frontend; the second creates the desktop app in `dist/`.

[Vite](https://vite.dev)
