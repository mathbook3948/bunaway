// Only the post-suite owned diagnostic process imports these regressions in order.
// Normal discovery must not initialize native state before the full-suite sentinel.
if (process.env.BUNAWAY_UI_SERVICE_SIZE_PAIR === "1") {
  await import("../lifecycle/windows-global-shortcut-ui.test.ts");
  await import("../lifecycle/windows-size-constraints.test.ts");
}
