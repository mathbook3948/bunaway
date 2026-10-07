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
