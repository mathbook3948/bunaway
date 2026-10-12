# OS metadata plugin

`@bunaway/plugin-os` provides permission-mediated `os.info(null)` and `os.locale(null)` on Windows.
Register `osPlugin` in the app definition. Each operation requires its own permission; registration grants none.
Trusted backends can use Bun, `process` and `node:os` directly for runtime metadata.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/os.mdx) for fields, locale meanings and failures.
The Windows adapter owns Kernel32 bindings until disposal. It reads current Windows locale settings with
[GetUserPreferredUILanguages](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getuserpreferreduilanguages),
[GetLocaleInfoEx](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getlocaleinfoex) and
[GetSystemDefaultUILanguage](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getsystemdefaultuilanguage).
These values describe configured language and region, not physical location.

`tests/api/os.test.ts` checks contracts and independent permissions. `tests/lifecycle/windows-os.test.ts`
executes the generated Windows adapter against actual Kernel32 and compares runtime metadata with Bun.
It is included in `mise run host:windows`; it does not change user language settings or validate translation hardware.
