# Native file dialogs

Optional `@bunaway/plugin-dialog` provides `openFile`, `selectFolder`, and `saveFile` on Windows.
Register the default export and grant each operation independently. See the
[public reference](../../docs/site/src/content/docs/reference/plugins/dialog.mdx) for inputs,
owner authorization, cancellation, limits and examples. Choosing paths never grants storage access.

The existing UI STA owns each IFileDialog, COM apartment reference, temporary timer HWND and FFI
binding. Show is synchronous on that worker; the app backend keeps running. A timer polls validated
control packets, and a host observer records cancellation intent without executing deferred plugin
handlers or cleanup inside the native callback. After Show returns, the existing channel dispatch
performs cancellation and shutdown. Ordinary concurrent UI calls serialize through the bounded host
channel. Native reentry fails BUSY. The picker closes on call cancellation, committed shutdown or a
retired captured owner. User dismissal is a successful `{ cancelled: true }`; lifecycle cancellation
is an error. Cancellation first calls IFileDialog.Close, then requests WM_CLOSE synchronously on the
current dialog HWND obtained through IOleWindow. This covers shell dialogs that acknowledge Close
without leaving Show from a timer callback. It never looks up windows by title or destroys a shell-owned HWND.
COM references and the timer window remain owned until the modal stack unwinds.

Microsoft references: [Common Item Dialog](https://learn.microsoft.com/en-us/windows/win32/shell/common-file-dialog),
[Show](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-imodalwindow-show),
[Close](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifiledialog-close),
[options](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/ne-shobjidl_core-_fileopendialogoptions).
The implementation preserves default existence/overwrite checks, forces filesystem results, and disables
recent-item insertion and test-file creation. A path remains subject to later replacement or deletion.

`tests/api/dialog.test.ts` uses the actual operation definitions with a controlled native driver.
`tests/lifecycle/worker-packets.test.ts` checks that modal intent observation follows validation and
precedes deferred dispatch. `tests/lifecycle/windows-dialog.test.ts` uses the real UI Worker and Windows
COM dialogs with injected native OK/Cancel commands, and tests abort, sequential dialogs and shutdown.
It is included in `host:windows`. Linux contract results do not establish Windows native execution.
Physical input, multiple-monitor layout, overwrite prompts, multi-selection UI and actual owner-window
retirement remain manual/native follow-up coverage.
