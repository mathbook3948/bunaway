import { expect, test } from "bun:test";
import { resolve } from "node:path";

const tests = resolve(import.meta.dir, "..");
const SHARED_MODULE = "fixtures/deadlines.ts";
/** A number of at least four digits where a wait is bounded: a deadline, not an interval. */
const MILLISECONDS = String.raw`[1-9]\d?_?\d{3,}`;
/** Where a test still writes its deadline as a number instead of naming it. */
const LITERAL_DEADLINE_FORMS = [
  // `}, N);`: a test's own timeout, or a timer whose callback spans lines.
  new RegExp(String.raw`^\s*\}, *${MILLISECONDS}\);\s*$`),
  // `setTimeout(() => child.kill(), N)` and other one-line timers.
  new RegExp(String.raw`setTimeout\([^;]*, *${MILLISECONDS}\)`),
  // `const deadline = Date.now() + N;`: a hand-rolled polling bound.
  new RegExp(String.raw`Date\.now\(\) *\+ *${MILLISECONDS}\b`),
];
/** A hand-rolled poller; `waitFor` in the shared module replaces it. */
const LOCAL_POLLER =
  /^\s*(?:async )?function (?:waitFor|waitUntil|until|poll)\w*\s*[(<]/;

/**
 * Files that still hold literal deadlines, with how many. Each count only goes down: moving a
 * wait to `deadline()`, `killAfter()` or `waitFor()` from `fixtures/deadlines.ts` lowers it, and
 * a file that reaches zero leaves the list. A new file, or a new literal in a listed file, fails.
 */
const LITERAL_DEADLINES: Record<string, number> = {
  "api/default-client.test.ts": 1,
  "cli/managed-command.test.ts": 3,
  "cli/windows-opener-files.ts": 1,
  "fixtures/android/app.ts": 1,
  "fixtures/macos-opener-receiver-app.ts": 3,
  "fixtures/macos-opener-receiver.ts": 1,
  "fixtures/process-host-job.ts": 1,
  "fixtures/windows-toast.fixture.ts": 2,
  "lifecycle/android-host.ts": 5,
  "lifecycle/macos-bun.test.ts": 13,
  "lifecycle/macos-desktop-host.test.ts": 3,
  "lifecycle/macos-host.ts": 1,
  "lifecycle/macos-image-host.ts": 1,
  "lifecycle/macos-log-capabilities-compiled.test.ts": 1,
  "lifecycle/macos-network.ts": 1,
  "lifecycle/macos-opener-native.test.ts": 1,
  "lifecycle/macos-startup-diagnostics.test.ts": 1,
  "lifecycle/macos-webview-regressions.ts": 1,
  "lifecycle/native-child-diagnostics.test.ts": 1,
  "lifecycle/windows-app-reload.ts": 2,
  "lifecycle/windows-bun-cli.ts": 3,
  "lifecycle/windows-bun-instance.test.ts": 1,
  "lifecycle/windows-bun-io.test.ts": 2,
  "lifecycle/windows-bun-process.ts": 1,
  "lifecycle/windows-bun-window-api.ts": 4,
  "lifecycle/windows-bun.ts": 1,
  "lifecycle/windows-clipboard.test.ts": 5,
  "lifecycle/windows-dialog.test.ts": 1,
  "lifecycle/windows-global-shortcut-ui.test.ts": 1,
  "lifecycle/windows-global-shortcut.test.ts": 1,
  "lifecycle/windows-hidden-webview.fixture.ts": 2,
  "lifecycle/windows-host-shutdown.test.ts": 2,
  "lifecycle/windows-image.test.ts": 1,
  "lifecycle/windows-initial-placement.ts": 3,
  "lifecycle/windows-menu-roles.ts": 1,
  "lifecycle/windows-menu-ui.test.ts": 1,
  "lifecycle/windows-modal-events.fixture.ts": 2,
  "lifecycle/windows-monitor-events.ts": 2,
  "lifecycle/windows-notification.test.ts": 1,
  "lifecycle/windows-opener-job.test.ts": 3,
  "lifecycle/windows-opener.test.ts": 2,
  "lifecycle/windows-path.ts": 1,
  "lifecycle/windows-plugin-registry.test.ts": 1,
  "lifecycle/windows-process.test.ts": 3,
  "lifecycle/windows-safe-storage.ts": 1,
  "lifecycle/windows-session-end.ts": 3,
  "lifecycle/windows-storage-metadata.ts": 1,
  "lifecycle/windows-tray-ui.test.ts": 1,
  "lifecycle/windows-webview-audio.ts": 2,
  "lifecycle/windows-webview-controls.ts": 2,
  "lifecycle/windows-webview-print-ui.ts": 2,
  "lifecycle/windows-webview-titlebar.ts": 2,
  "lifecycle/windows-window-events.ts": 2,
  "lifecycle/windows-windowless.ts": 2,
  "packaging/macos-distribution.test.ts": 1,
  "packaging/windows-associations.test.ts": 1,
  "packaging/windows-autostart.test.ts": 1,
};
/** Files that still define their own poller, with how many. Same ratchet. */
const LOCAL_POLLERS: Record<string, number> = {
  "cli/dev.fixture.ts": 1,
  "cli/vite.ts": 1,
  "fixtures/macos-desktop/app.ts": 2,
  "fixtures/macos-opener-receiver-app.ts": 1,
  "fixtures/process-host-job.ts": 1,
  "lifecycle/macos-host.ts": 1,
  "lifecycle/macos-network.ts": 1,
  "lifecycle/macos-webview-regressions.ts": 1,
  "lifecycle/windows-app-reload.ts": 1,
  "lifecycle/windows-bun-window-api.ts": 1,
  "lifecycle/windows-close-request.ts": 1,
  "lifecycle/windows-context-menu.fixture.ts": 1,
  "lifecycle/windows-host.ts": 1,
  "lifecycle/windows-initial-placement.ts": 1,
  "lifecycle/windows-monitor-events.ts": 1,
  "lifecycle/windows-opener-recent.test.ts": 1,
  "lifecycle/windows-session-end.ts": 1,
  "lifecycle/windows-ui-lifecycle.test.ts": 1,
  "lifecycle/windows-ui-operations.test.ts": 2,
  "lifecycle/windows-window-events.ts": 1,
  "lifecycle/windows-windowless.ts": 1,
  "packaging/windows-associations.test.ts": 1,
};

async function countMatches(
  patterns: readonly RegExp[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for await (const file of new Bun.Glob("**/*.ts").scan({
    cwd: tests,
  })) {
    const path = file.replaceAll("\\", "/");
    if (path === SHARED_MODULE || /(^|\/)(node_modules|web)\//.test(path)) {
      continue;
    }
    const lines = (await Bun.file(resolve(tests, path)).text()).split("\n");
    const hits = lines.filter((line) =>
      patterns.some((pattern) => pattern.test(line)),
    ).length;
    if (hits > 0) {
      counts.set(path, hits);
    }
  }
  return counts;
}

function ratchet(
  label: string,
  baseline: Record<string, number>,
  found: Map<string, number>,
): void {
  const grown = [
    ...found,
  ]
    .filter(([path, count]) => count > (baseline[path] ?? 0))
    .map(
      ([path, count]) => `${path}: ${count} (baseline ${baseline[path] ?? 0})`,
    )
    .sort();
  // Name the wait with `deadline()`, `killAfter()` or `waitFor()` from tests/fixtures/deadlines.ts.
  expect(grown, `${label} grew`).toEqual([]);
  const stale = Object.entries(baseline)
    .filter(([path, count]) => (found.get(path) ?? 0) < count)
    .map(
      ([path, count]) => `${path}: ${found.get(path) ?? 0} (baseline ${count})`,
    )
    .sort();
  // A lowered count stays lowered: update the baseline so the ratchet keeps its ground.
  expect(stale, `${label} baseline is stale`).toEqual([]);
}

test("the shared deadlines module is the only place a wait is a number", async () => {
  const source = await Bun.file(resolve(tests, SHARED_MODULE)).text();
  expect(source).toContain("export const DEADLINES");
  expect(source).toContain("export function deadline(");
  expect(source).toContain("export function killAfter(");
  expect(source).toContain("export async function waitFor<");
});

test("literal deadlines in tests only shrink", async () => {
  ratchet(
    "literal deadlines",
    LITERAL_DEADLINES,
    await countMatches(LITERAL_DEADLINE_FORMS),
  );
});

test("hand-rolled pollers in tests only shrink", async () => {
  ratchet(
    "local pollers",
    LOCAL_POLLERS,
    await countMatches([
      LOCAL_POLLER,
    ]),
  );
});
