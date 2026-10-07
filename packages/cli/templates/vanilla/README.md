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

The generated UI infers command and event types from the app definition:

```ts
import type { CommandsOf, EventsOf } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
import type { app } from "../src-bunaway/app.ts";

const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
const text = await client.invoke("message.read", null);
```

`bun run typecheck` rejects unknown command and event names and invalid payloads.
The type-only imports keep backend implementation out of the browser bundle.
The client uses the shared WebView connection without transport setup. Call the
disposer returned by `client.listen` when the UI component is removed. Backend calls work in the desktop
app; calls from a regular browser fail with `UNSUPPORTED`.
The UI creates the client during startup so connection failures appear in the
status message and keep the Save button disabled.

## Build

```sh
bun run build
```

The desktop app is written to `dist/`.
