# Native dialogs

Optional `@bunaway/plugin-dialog` provides the file pickers `openFile`, `selectFolder` and `saveFile`
and the message dialog `showMessage` on Windows.
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

## Message dialog

`showMessage` validates the request (`messageSchema` in `src/contract.ts`) before any native
allocation and returns `{ button, checkboxChecked }`. Unlike the pickers, user dismissal is a normal
button result: Escape, the title-bar close button and Alt+F4 return the resolved cancel button
(`resolveCancelButton`). With several buttons and no `cancelButton` they are disabled, so the user must
click a button. Host abort, deadline, shutdown and owner retirement are CANCELLED or TIMEOUT errors,
never a button result. Owner rules, the single UI-thread queue and BUSY on native reentry are shared
with the pickers through the same `run` path in `src/platforms/windows.ts`.

The dialog is `TaskDialogIndirect` from comctl32 v6. `bun.exe` has no Common-Controls v6 manifest, so
each call writes a private temporary manifest file, creates an activation context with `CreateActCtxW`,
deletes the file immediately, and activates the context on the UI STA around loading comctl32 and the
modal call. Cancellation is polled from the `TDN_TIMER` callback (about 200 ms, coarser than the 25 ms
picker timer) and closes the dialog with a synchronous `TDM_CLICK_BUTTON`. Callbacks never throw through
native frames. Custom buttons use ids offset from the button index, and the cancel button is mapped to
`IDCANCEL` so Escape resolves to it.

Microsoft references: [TaskDialogIndirect](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/nf-commctrl-taskdialogindirect),
[TASKDIALOGCONFIG](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/ns-commctrl-taskdialogconfig),
[CreateActCtxW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createactctxw).

## Tests

`tests/api/dialog.test.ts` uses the actual operation definitions with a controlled native driver,
including message input validation, the cancel rule and results.
`tests/lifecycle/worker-packets.test.ts` checks that modal intent observation follows validation and
precedes deferred dispatch. `tests/lifecycle/windows-dialog.test.ts` uses the real UI Worker and Windows
COM dialogs with injected native OK/Cancel commands, and tests abort, sequential dialogs and shutdown.
The real dialog fixture runs in a child process because Shell can retain process-wide COM helpers
after the owning UI STA unwinds. All modal assertions run unchanged inside that process.
It is included in `host:windows`. Linux contract results do not establish Windows native execution.
Physical input, multiple-monitor layout, overwrite prompts, multi-selection UI and actual owner-window
retirement remain manual/native follow-up coverage.

The packed (pshpack1) `TASKDIALOGCONFIG` layout is verified by Linux contract tests. Real TaskDialog
behavior (custom button click, checkbox, Escape through `IDCANCEL`, abort) is covered only by the
Windows-only lifecycle test.
