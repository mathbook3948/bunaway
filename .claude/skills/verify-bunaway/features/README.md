# bunaway verification map

This directory is the maintained source for verifying what an app developer can observe from the
bunaway framework. Read this index before driving anything, then use the matching feature file as
the recipe.

## Baseline preconditions

- Run from the repository root with `bun install --frozen-lockfile` done and Bun 1.4.2.
- Choose a run id and keep everything under `build/verify-bunaway/<run>/`: `packages/` from
  `pack`, `app/` from `create`, `evidence/` for proofs.
- `doctor` on the project reports four `OK` lines before any drive.
- Never drive a project or a process this run did not create.

## Driving conventions

- Every command is `bun .claude/skills/verify-bunaway/scripts/verify-bunaway.ts <command> <dir>`,
  written below as `verify-bunaway <command> <dir>`.
- Treat commands as literal. Template names, options and quoted texts stay unchanged.
- Pass `--evidence build/verify-bunaway/<run>/evidence` to `backend` and `web` so proofs land
  outside the project.
- Start every recipe from a freshly created project unless its preconditions say otherwise.

## Proof and skip reporting

- A proof names the feature ID, the run id, the command, its exit code and the evidence file.
- Backend proof quotes the `frames` entries that show the request and its reply, plus the
  `host-store` file for a mutation.
- Web proof quotes the served HTML line that carries the Vite client script.
- Report an unreachable path with the command attempted and the unmet precondition. A feature that
  only the native hosts can prove is reported as "not verifiable on this OS", never as verified
  through the backend drive.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior,
then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`,
`Driving it with verify-bunaway`, `Gotchas`.

## Features

- [Create a project](./create-project.md) covers the packed CLI's `create`, install, `validate` and
  `doctor` for every template.
- [Backend commands and events](./backend-commands.md) covers the host process protocol, the SDK
  channel, policy enforcement, `message.save`, `message.saved` and `message.read`.
- [Web dev server](./web-dev-server.md) covers the Vite-family templates' `dev:web` server and the
  CSP the CLI injects.
- [Native hosts](./native-hosts.md) covers windows, WebViews, native plugins and packaging, which
  only the Windows and macOS runners can prove.
