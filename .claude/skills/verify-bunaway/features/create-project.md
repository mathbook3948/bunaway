# Create a project

An app developer installs the framework packages, runs `bunaway create` with a template, installs
the project and gets a configuration that `bunaway validate` accepts and `bunaway doctor` reports on.

## Sub-features

- `create-template` generates a project from each template: `vanilla`, `vite`, `react`, `vue`,
  `svelte`.
- `create-install` installs the generated project against the packed local packages.
- `create-validate` accepts the generated `bunaway.json` and `policy.json`.
- `create-doctor` reports the environment and configuration state.

## How to get to it (user POV)

- Run `bunaway create <directory> --template <name> --package-dir <tarballs>` from the packed CLI.
- Run `bun install` inside the new directory.
- Run `bun run validate` and `bun run doctor` inside it, the scripts the template's `package.json`
  defines.

## Driving it with verify-bunaway

Preconditions:

- `verify-bunaway pack build/verify-bunaway/<run>/packages` finished with "packed framework into".
- The target directory does not exist.

- **Create and install.** Run `verify-bunaway create build/verify-bunaway/<run>/app --packages
  build/verify-bunaway/<run>/packages --template vanilla`. Exit code `0` and the line "created
  vanilla project at ...". The directory holds `package.json`, `src-bunaway/bunaway.json`,
  `src-bunaway/policy.json` and `node_modules/@bunaway/runtime-bun`.
- **Other templates.** Repeat with `--template vite`, `react`, `vue` and `svelte` into separate
  directories. Each adds `vite.config.ts` and a `dev` block in `src-bunaway/bunaway.json`.
- **Validate and doctor.** Run `verify-bunaway doctor build/verify-bunaway/<run>/app`. Four `OK`
  lines; the `validate` line ends with "Configuration and policy are valid.".
- **CLI doctor (informational).** Run `bun run doctor` inside the project. On Linux it prints
  `FAIL target` and `FAIL codesign`, because native builds need Windows x64 or macOS arm64, and
  exits 1. On those platforms every line is `OK`.
- **Proof.** The `create` and `doctor` outputs with exit codes, and `ls` of the project root.

## Gotchas

- `create` refuses a directory that already exists. Use a new run id.
- The packed CLI is extracted under the OS temp directory (`bunaway-verify-cli-<hash>`), never
  inside the packages directory or the project: the artifact audits its own inventory and refuses
  to run once anything is installed inside it.
- `bun install` inside the project resolves `@bunaway/*` to the tarballs `--package-dir` named. A
  project created against one packages directory cannot be reinstalled against another.
- Template `src` and `public` directories are excluded from the repository's Biome config; do not
  judge the generated UI files by the repository's lint rules.
