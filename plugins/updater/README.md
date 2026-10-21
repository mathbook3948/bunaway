# Updater plugin

`@bunaway/plugin-updater` provides the permission-mediated `updater.check(null)` on Windows and macOS.
Register `updater` in the app definition and set `plugins.updater` in `src-bunaway/bunaway.json`.
The operation requires its own permission; registration grants none.

`check` fetches the app's fixed manifest endpoint, compares its version with the app version (SemVer 2.0.0)
and returns the newer version, release notes, publication time and download URL. It does not download,
verify signatures or install anything. The endpoint comes from settings only; callers cannot choose it.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/updater.mdx) for settings,
manifest format, limits and failures, and [ADR 0025](../../docs/decisions/0025-plugin-settings-and-app-version.md)
for how settings and the app version reach the adapter.

The comparison, manifest validation and request handling are platform neutral (`src/check.ts`, `src/semver.ts`,
`src/endpoint.ts`); the platform adapters only name the update target. `tests/api/updater-check.test.ts` checks
the logic against an injected `fetch`, without a network.
