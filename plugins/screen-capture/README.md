# ScreenCapture plugin

`@bunaway/plugin-screen-capture` provides permission-mediated `screenCapture.listSources` and
`screenCapture.captureSource` on Windows. It lists monitors and top-level windows and captures one of them as a PNG.
Register `screenCapture` in the app definition. Each operation requires its own permission; registration grants none.
Screen content is sensitive and Windows shows no capture indicator, so grant the permissions only to views that start a
trusted backend command.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/screen-capture.mdx) for inputs, results and failures.
The adapter opens user32, gdi32 and dwmapi in `initialize`, owns the GDI objects of each capture for the duration of the
call, and closes the libraries in `dispose`.

`listSources` takes an optional `thumbnailSize` and then returns a fitted PNG with each source, within one total byte
budget. A source that cannot be captured stays listed without a thumbnail, and a listing with thumbnails also needs the
`screenCapture.captureSource` permission.

`tests/api/screen-capture.test.ts` checks the contract, the independent permissions, the capture logic against fake
bindings and the PNG encoder. `tests/lifecycle/windows-screen-capture.test.ts` captures a window of the test process on
Windows.
