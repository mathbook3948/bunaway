# Updater plugin

`@bunaway/plugin-updater` provides the permission-mediated `updater.check(null)` and `updater.download(null)` on Windows and macOS.
Register `updater` in the app definition and set `plugins.updater` in `src-bunaway/bunaway.json`.
Each operation requires its own permission; registration grants none.

`check` fetches the app's fixed manifest endpoint, compares its version with the app version (SemVer 2.0.0)
and returns the newer version, release notes, publication time and download URL. The endpoint comes from
settings only; callers cannot choose it.

`download` saves the package the last `check` found into `<dataRoot>/data/updates/<sha256>.package`, keeping it only
when its size and SHA-256 match the manifest's `sha256` and `size`. It takes no address or path, removes partial
files on failure, cancellation and time limit, and stops at 1 GiB or 30 minutes. When the app sets
`plugins.updater.authenticode.publisherNames`, a Windows package (PE or MSI) is also kept only if its Authenticode
signature is valid for the whole chain and the signer's certificate matches one of the names; macOS refuses such a
download. The Windows CI test signs executables only: a signed MSI was not exercised, only its format detection. It does
not install or report progress.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/updater.mdx) for settings,
manifest format, limits and failures, and [ADR 0025](../../docs/decisions/0025-plugin-settings-and-app-version.md)
for how settings and the app version reach the adapter.

The comparison, manifest validation, request handling and download are platform neutral (`src/check.ts`,
`src/download.ts`, `src/request.ts`, `src/semver.ts`, `src/endpoint.ts`, and the publisher comparison in `src/signature.ts`
and `src/distinguished-name.ts`); the platform adapters name the update target and provide the update folder
(`src/platforms/package-files.ts`). The Windows adapter checks signatures in worker threads
(`src/platforms/windows-authenticode.ts`, `src/platforms/signature-worker.ts`). `tests/api/updater-download.test.ts` checks the download
against an injected `fetch` and a temporary data folder. `tests/api/updater-signature.test.ts` checks the publisher comparison and the failure contract with a fake verifier, and
`tests/lifecycle/windows-updater-signature.test.ts` checks real `WinVerifyTrust` results on a Windows CI runner.
`tests/api/updater-check.test.ts` checks
the logic against an injected `fetch`, and the decompressed size limit, a stalled body and the registered plugin
against a loopback HTTP server on the same machine.
