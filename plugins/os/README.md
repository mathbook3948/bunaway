# OS metadata plugin

`@bunaway/plugin-os` provides permission-mediated `os.info(null)`, `os.usage(null)`, `os.locale(null)` and `os.beep({ kind })` on Windows and macOS, and `os.listPrinters(null)`, `os.getDefaultPrinter(null)`, `os.listGpus(null)`, `os.listAppProcesses(null)` and `os.getMediaAccessStatus({ mediaType })` on Windows.
Register `os` in the app definition. Each operation requires its own permission; registration grants none.
Trusted backends can use Bun, `process` and `node:os` directly for runtime metadata.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/os.mdx) for fields, locale meanings and failures.
The Windows adapter owns Kernel32 bindings until disposal. It reads current Windows locale settings with
[GetUserPreferredUILanguages](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getuserpreferreduilanguages),
[GetLocaleInfoEx](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getlocaleinfoex) and
[GetSystemDefaultUILanguage](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getsystemdefaultuilanguage).
These values describe configured language and region, not physical location.

The macOS adapter reads the locale and preferred languages through CoreFoundation, Rosetta translation through
`sysctl.proc_translated`, and plays the user's alert sound with AudioToolbox `AudioServicesPlayAlertSound`.
It owns those library handles until disposal. `tests/api/os-macos.test.ts` checks the pure helpers and registration;
`tests/lifecycle/macos-os.test.ts` runs the adapter against the real frameworks and is part of the macOS native run.

`tests/api/os.test.ts` checks contracts and independent permissions. `tests/lifecycle/windows-os.test.ts`
executes the generated Windows adapter against actual Kernel32 and compares runtime metadata with Bun.
It is included in `mise run host:windows`; it does not change user language settings or validate translation hardware.

`os.beep({ kind })` calls user32 `MessageBeep` with default, info, warning or error sound types and returns
without waiting for playback. The emoji panel is unsupported: Windows has no official API and only Win+. key
synthesis, which depends on the focused window.

`os.listPrinters` calls winspool `EnumPrintersW` at level 4 (name only, local and connected printers) and
`os.getDefaultPrinter` calls `GetDefaultPrinterW`. The adapter sizes the buffer first, retries when the list grows
in between, and checks every name pointer against the returned buffer before reading it. macOS rejects both with
`UNSUPPORTED`. `tests/api/os-printers.test.ts` covers the parser with fake bindings; `tests/lifecycle/windows-os.test.ts`
runs both calls against the real spooler, where an empty list and a `null` default are valid on a runner without printers.
A populated list and network-printer latency are not covered by CI.

`os.listGpus` creates a DXGI factory per call (`CreateDXGIFactory1`), reads each adapter with `EnumAdapters1` and
`GetDesc1` and releases the adapters and the factory before returning. It reports name, PCI vendor and device ID,
dedicated video memory and the software-renderer flag; driver versions and renderer metrics are not included.
macOS rejects it with `UNSUPPORTED`. `tests/api/os-gpus.test.ts` covers the `DXGI_ADAPTER_DESC1` layout, limits and
release of every COM object with fake bindings; `tests/lifecycle/windows-os.test.ts` runs the call against real DXGI,
where CI checks that the list is valid and not empty. Hardware GPU lists are not covered by CI.

`os.listAppProcesses` takes one Toolhelp snapshot (`CreateToolhelp32Snapshot`) and walks the descendants of the app's
own process. Windows runs the host and the backend in one Bun process, so that process is reported once as `app`.
A descendant is `webview2` when it, or an ancestor below the app, runs from `msedgewebview2.exe`, and `other`
otherwise. The image name only classifies; no path, command line or other process memory is read. Metrics come from
`GetProcessTimes` and `K32GetProcessMemoryInfo` on a `PROCESS_QUERY_LIMITED_INFORMATION` handle that is closed before
the call returns; a process that cannot be opened, or ends while it is queried, keeps its entry with `metrics: null`. A child that was created
before its listed parent is a reused process ID and is left out. More than 256 processes is an error.
macOS rejects it with `UNSUPPORTED`. `tests/api/os-app-processes.test.ts` covers the structure layouts, tree walk,
classification and limits with fake bindings; `tests/lifecycle/windows-os.test.ts` lists the real tree, including a
child the test starts. Renderer-internal metrics and startup time are not included.

`os.usage` reports cumulative process CPU microseconds, memory bytes, logical CPU count and actual
IsWow64Process2 machine values. Windows x64 CI does not validate ARM64 translation hardware.

Windows region identifiers can be two-letter codes or three-digit numeric regions such as Caribbean `029`.
The value remains a string, preserving leading zeros, as documented by Microsoft's
[LOCALE_SISO constants](https://learn.microsoft.com/en-us/windows/win32/intl/locale-siso-constants).
The deterministic locale regression uses the same assertion as the actual Windows test and rejects malformed shapes.

`os.getMediaAccessStatus` reads the `Value` string under the `CapabilityAccessManager\ConsentStore\webcam` or `microphone`
key with `RegGetValueW`, first in `HKLM` (device-wide setting; `Deny` is `restricted`; group policy keys are not read) and then in `HKCU` (`Allow` is `granted`, `Deny` is
`denied`, no value is `not-determined`). A failed read or any other value is `unknown`. `RegGetValueW` takes the predefined
hive and subkey path directly, so no key handle is opened; the key paths are constants and caller input never reaches them. Per-app
`NonPackaged` subkeys (the desktop-app access toggle and per-app entries) are not read, so `granted` does not rule out that desktop apps are blocked. macOS rejects it with `UNSUPPORTED`. `tests/api/os-media-access.test.ts` covers the decision
table and the key choice with fake bindings; `tests/lifecycle/windows-os.test.ts` runs both device classes against the real
consent store, where CI checks that the call succeeds and returns the status that the same keys read with `reg.exe` give under the decision table.
