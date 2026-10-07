# Bunaway + React + Vite

A starter for Bunaway desktop apps with React, Vite and TypeScript.

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
`src/client.ts` derives command names, inputs, results and event payloads from the app definition.
Import its `client` in UI components. For example, `await client.invoke("message.read", null)` returns a string.

Backend commands and their services can import `storage`, `log`, and `capabilities`
from `@bunaway/plugin-storage`, `@bunaway/plugin-log`, and `@bunaway/plugin-capabilities`, respectively. The SDK uses the current command's Host permissions
and cancellation signal, without passing `context.host` through service arguments.
Await Host operations before the command returns. Calls outside an execution context
or after command completion are rejected. The starter allows storage under `appData/messages`;
app logging requires installing `@bunaway/plugin-log`, registering `logPlugin` and allowing `log:write` in the calling view permissions.

## Build

```sh
bun run build
bun run bunaway build
```

The first command builds the frontend; the second creates the desktop app in `dist/`.

[Vite](https://vite.dev)

UI files come from create-vite@9.2.1 (`react-ts`); see `public/LICENSE.vite.txt`.
Run `bun run typecheck` to check the frontend, backend and Vite configuration.
React Fast Refresh allows inline scripts only in development; production uses `script-src 'self'`.

The message example installs and registers `@bunaway/plugin-storage`. Host permissions use the v1 `permissions` array in `src-bunaway/policy.json`.

Plugin functions use the same package import in frontend and backend code, such as `@bunaway/plugin-storage`. `bun run typecheck` checks frontend `browser` conditions and backend `bun` conditions using `src-bunaway/tsconfig.json`.
