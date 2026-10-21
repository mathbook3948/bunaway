# Updater plugin

`@bunaway/plugin-updater` provides the permission-mediated `updater.check(null)` and `updater.download(null)` on Windows and macOS.
Register `updater` in the app definition and set `plugins.updater` in `src-bunaway/bunaway.json`.
Each operation requires its own permission; registration grants none.

`check` fetches the app's fixed manifest endpoint, compares its version with the app version (SemVer 2.0.0)
and returns the newer version, release notes, publication time and download URL. The endpoint comes from
settings only; callers cannot choose it.

`download` saves the package the last `check` found into `<dataRoot>/data/updates/<sha256>.package`, keeping it only
when its size and SHA-256 match the manifest's `sha256` and `size`. It takes no address or path, removes partial
files on failure, cancellation and time limit, and stops at 1 GiB or 30 minutes. It does not verify signatures,
install or report progress.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/updater.mdx) for settings,
manifest format, limits and failures, and [ADR 0025](../../docs/decisions/0025-plugin-settings-and-app-version.md)
for how settings and the app version reach the adapter.

The comparison, manifest validation, request handling and download are platform neutral (`src/check.ts`,
`src/download.ts`, `src/request.ts`, `src/semver.ts`, `src/endpoint.ts`); the platform adapters name the update target
and provide the update folder (`src/platforms/package-files.ts`). `tests/api/updater-download.test.ts` checks the download
against an injected `fetch` and a temporary data folder. `tests/api/updater-check.test.ts` checks
the logic against an injected `fetch`, and the decompressed size limit, a stalled body and the registered plugin
against a loopback HTTP server on the same machine.
