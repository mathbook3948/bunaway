# CrashReport plugin

`@bunaway/plugin-crash-report` provides permission-mediated `crashReport.enable`, `disable`, `list` and `remove` on Windows.
Register `crashReport` in the app definition. Each operation requires its own permission; registration grants none.

It registers the host process with Windows Error Reporting (`WerRegisterAppLocalDump`) so that a crash leaves a dump in
`<app data>\crash-dumps`, and lists that folder on a later run. The plugin reports an id, time, size and kind per dump and
never a path or content, because a dump holds process memory. It does not upload anything.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/crash-report.mdx) for inputs, results and failures.
`src/platforms/dump-folder.ts` owns the folder rules (regular `.dmp` files only, bounded scan, newest-first retention),
`src/platforms/windows-wer.ts` owns the native library, and `WindowsCrashReport` owns the registration state.

`tests/api/crash-report.test.ts` checks the folder rules, registration state and independent permissions with fake bindings.
`tests/lifecycle/windows-crash-report.test.ts` registers for real and ends child processes with a crash on the Windows CI job.
