import { expect, test } from "bun:test";
import {
  isDownloadSnapshotWithinLimits,
  MAX_DOWNLOAD_METADATA_BYTES,
  MAX_DOWNLOAD_SNAPSHOT_BYTES,
  MAX_WEBVIEW_DOWNLOADS,
  type WebViewDownload,
} from "@bunaway/plugin-api/native";
import {
  MAX_MESSAGE_BYTES,
  serializeMessage,
  serializeProcessFrame,
} from "@bunaway/protocol";
import {
  type DownloadChangeKind,
  DownloadCleanupError,
  DownloadCleanupRetries,
  type DownloadResource,
  Downloads,
} from "#native/windows/bun/downloads";
import { waitFor } from "../fixtures/deadlines.ts";

/** A controllable native operation, with observable decisions and resource releases. */
function resource() {
  const state: Omit<WebViewDownload, "id" | "paused"> = {
    url: "https://app.bunaway.local/file.txt",
    mimeType: "text/plain",
    contentDisposition: 'attachment; filename="file.txt"',
    path: "C:\\Users\\test\\Downloads\\file.txt",
    totalBytes: 100,
    receivedBytes: 0,
    state: "pending",
    interruptReason: null,
    canResume: false,
  };
  const decisions: boolean[] = [];
  let disposed = 0;
  let cancelled = 0;
  let abandoned = false;
  let failure: Error | undefined;
  let readFailure: Error | undefined;
  let cancelFailure: Error | undefined;
  let notify: ((kind: DownloadChangeKind) => void) | undefined;
  const native: DownloadResource = {
    read() {
      if (readFailure) {
        throw readFailure;
      }
      return {
        ...state,
      };
    },
    decide(allow) {
      decisions.push(allow);
      if (failure) {
        throw failure;
      }
      state.state = allow ? "inProgress" : "interrupted";
    },
    cancel() {
      cancelled++;
      if (cancelFailure) {
        throw cancelFailure;
      }
      state.state = "interrupted";
      state.interruptReason = 26; // USER_CANCELED
    },
    pause() {
      state.state = "interrupted";
      state.canResume = true;
      state.interruptReason = 28; // USER_PAUSED
    },
    resume() {
      state.state = "inProgress";
      state.canResume = false;
      state.interruptReason = null;
    },
    subscribe(callback) {
      notify = callback;
    },
    dispose(browserGone = false) {
      disposed++;
      abandoned = browserGone;
      notify = undefined;
    },
  };
  return {
    native,
    state,
    decisions,
    get disposed() {
      return disposed;
    },
    get cancelled() {
      return cancelled;
    },
    get abandoned() {
      return abandoned;
    },
    /** The native event handler; absent before approval and after disposal. */
    get notify() {
      return notify;
    },
    fail: (error: Error) => {
      failure = error;
    },
    failRead: (error?: Error) => {
      readFailure = error;
    },
    failCancel: (error?: Error) => {
      cancelFailure = error;
    },
  };
}

function fixture(timeoutMs = 30_000, progressIntervalMs = 250) {
  const failures: unknown[] = [];
  const reports: WebViewDownload[] = [];
  const downloads = new Downloads(
    (url, source) =>
      url.startsWith("https://app.bunaway.local/") &&
      source.startsWith("https://app.bunaway.local/"),
    timeoutMs,
    (error) => failures.push(error),
    undefined,
    (download) => reports.push(download),
    progressIntervalMs,
  );
  const offer = (
    item: ReturnType<typeof resource>,
    source = "https://app.bunaway.local/index.html",
  ) => downloads.offer(item.native, source);
  return {
    downloads,
    offer,
    failures,
    reports,
  };
}

test("downloads deny by default and reject untrusted origins without retaining resources", () => {
  const f = fixture();
  const disabled = resource();
  expect(f.offer(disabled)).toBeNull();
  expect(disabled.decisions).toEqual([
    false,
  ]);
  expect(disabled.disposed).toBe(1);
  f.downloads.setRequestsEnabled(true);
  for (const invalidSource of [
    false,
    true,
  ]) {
    const item = resource();
    if (!invalidSource) {
      item.state.url = "https://outside.invalid/file.txt";
    }
    expect(
      f.offer(item, invalidSource ? "https://outside.invalid/" : undefined),
    ).toBeNull();
    expect(item.decisions).toEqual([
      false,
    ]);
    expect(item.disposed).toBe(1);
  }
  expect(f.downloads.list()).toEqual([]);
  f.downloads.dispose();
});

test("observed browser failure releases pending and approved resources without calling a dead broker", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const pending = resource();
  const active = resource();
  f.offer(pending);
  const id = f.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  f.downloads.dispose(true);
  expect(pending.decisions).toEqual([]);
  expect(active.decisions).toEqual([
    true,
  ]);
  expect(active.cancelled).toBe(0);
  expect(pending.abandoned).toBe(true);
  expect(active.abandoned).toBe(true);
  expect(pending.disposed).toBe(1);
  expect(active.disposed).toBe(1);
});

test("individual approval owns progress, pause/resume and terminal snapshots", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const item = resource();
  const id = f.offer(item);
  expect(id).not.toBeNull();
  if (!id) {
    throw new Error("Missing request");
  }
  expect(f.downloads.list()[0]?.state).toBe("pending");
  expect(item.decisions).toEqual([]);
  f.downloads.approve(id);
  expect(item.decisions).toEqual([
    true,
  ]);
  expect(() => f.downloads.approve(id)).toThrow();
  item.state.receivedBytes = 25;
  const copy = f.downloads.list();
  expect(copy[0]?.receivedBytes).toBe(25);
  if (copy[0]) {
    copy[0].path = "changed";
  }
  expect(f.downloads.list()[0]?.path).toBe(item.state.path);
  f.downloads.pause(id);
  expect(f.downloads.list()[0]).toMatchObject({
    paused: true,
    canResume: true,
    state: "interrupted",
  });
  f.downloads.resume(id);
  expect(f.downloads.list()[0]).toMatchObject({
    paused: false,
    state: "inProgress",
  });
  expect(() => f.downloads.resume(id)).toThrow();
  expect(() => f.downloads.forget(id)).toThrow();
  item.state.receivedBytes = 100;
  item.state.state = "completed";
  expect(f.downloads.list()[0]).toMatchObject({
    state: "completed",
    receivedBytes: 100,
  });
  expect(item.disposed).toBe(1);
  f.downloads.cancel(id);
  expect(f.downloads.list()[0]?.state).toBe("completed");
  f.downloads.forget(id);
  expect(f.downloads.list()).toEqual([]);
  f.downloads.dispose();
  expect(item.disposed).toBe(1);
});

test("navigation and disabling cancel pending approvals without cancelling backend-approved downloads", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const approved = resource();
  const pending = resource();
  const first = f.offer(approved);
  const second = f.offer(pending);
  if (!first || !second) {
    throw new Error("Missing requests");
  }
  f.downloads.approve(first);
  f.downloads.revokePending();
  expect(pending.decisions).toEqual([
    false,
  ]);
  expect(approved.cancelled).toBe(0);
  expect(() => f.downloads.approve(second)).toThrow();
  f.downloads.setRequestsEnabled(false);
  const denied = resource();
  expect(f.offer(denied)).toBeNull();
  f.downloads.cancel(first);
  f.downloads.cancel(first);
  expect(approved.cancelled).toBe(1);
  expect(approved.disposed).toBe(1);
  f.downloads.dispose();
});

test("an interrupted transfer retains cancellation authority across a native automatic retry", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = f.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  active.state.state = "interrupted";
  active.state.canResume = false;
  expect(f.downloads.list()[0]?.state).toBe("interrupted");
  expect(active.disposed).toBe(0);
  expect(() => f.downloads.forget(id)).toThrow();
  active.state.state = "inProgress";
  active.state.receivedBytes = 50;
  expect(f.downloads.list()[0]?.receivedBytes).toBe(50);
  f.downloads.cancel(id);
  expect(active.cancelled).toBe(1);
  expect(active.disposed).toBe(1);
  f.downloads.forget(id);
  f.downloads.dispose();
});

test("bounded retention denies overflow and terminal removal releases capacity", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const ids: string[] = [];
  for (let i = 0; i < MAX_WEBVIEW_DOWNLOADS; i++) {
    const id = f.offer(resource());
    if (!id) {
      throw new Error("Unexpected capacity denial");
    }
    ids.push(id);
    f.downloads.cancel(id);
  }
  const overflow = resource();
  expect(f.offer(overflow)).toBeNull();
  expect(overflow.disposed).toBe(1);
  f.downloads.forget(ids[0] ?? "");
  expect(f.offer(resource())).not.toBeNull();
  expect(() => f.downloads.approve(crypto.randomUUID())).toThrow();
  f.downloads.dispose();
});

test("approval expiry rejects exactly once and cannot approve a stale handle", async () => {
  const f = fixture(5);
  f.downloads.setRequestsEnabled(true);
  const item = resource();
  const id = f.offer(item);
  if (!id) {
    throw new Error("Missing request");
  }
  await Bun.sleep(20);
  expect(item.decisions).toEqual([
    false,
  ]);
  expect(item.disposed).toBe(1);
  expect(f.downloads.list()[0]?.state).toBe("cancelled");
  expect(() => f.downloads.approve(id)).toThrow();
  expect(f.failures).toEqual([]);
  f.downloads.dispose();
});

test("failed decisions preserve ownership until a retry and cleanup reports owned failures", async () => {
  const f = fixture(5);
  f.downloads.setRequestsEnabled(true);
  const failed = resource();
  failed.fail(new Error("Native deferral failed"));
  const id = f.offer(failed);
  if (!id) {
    throw new Error("Missing request");
  }
  await Bun.sleep(20);
  expect(f.failures).toHaveLength(1);
  expect(failed.disposed).toBe(0);
  expect(() => f.downloads.approve(id)).toThrow();
  f.downloads.cancel(id);
  expect(failed.disposed).toBe(1);
  const failClose = resource();
  failClose.fail(new Error("Native cancel failed"));
  const peer = resource();
  f.offer(failClose);
  f.offer(peer);
  expect(() => f.downloads.dispose()).toThrow("Download cleanup failed");
  expect(failClose.disposed).toBe(0);
  expect(peer.decisions).toEqual([
    false,
  ]);
  expect(peer.disposed).toBe(1);
  expect(() => f.downloads.list()).not.toThrow();
  expect(() => f.downloads.dispose()).not.toThrow();
  expect(failClose.disposed).toBe(1);
  expect(() => f.downloads.list()).toThrow();
});

test("metadata failures cannot block cancellation and failed Cancel retains retry authority", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = f.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  active.failRead(new Error("Metadata read failed"));
  active.failCancel(new Error("Native Cancel failed"));
  expect(() => f.downloads.cancel(id)).toThrow("Native Cancel failed");
  expect(active.cancelled).toBe(1);
  expect(active.disposed).toBe(0);
  active.failRead();
  expect(f.downloads.list()[0]?.state).toBe("inProgress");
  expect(() => f.downloads.forget(id)).toThrow();
  active.failRead(new Error("Metadata remains unavailable"));
  active.failCancel();
  expect(() => f.downloads.cancel(id)).not.toThrow();
  expect(active.cancelled).toBe(2);
  expect(active.disposed).toBe(1);
  expect(f.downloads.list()[0]?.state).toBe("cancelled");
  f.downloads.forget(id);
  f.downloads.dispose();
});

test("failed cancellation during approval or close retains every active resource until retry", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = f.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  active.failRead(new Error("Approved metadata failed"));
  active.failCancel(new Error("Native Cancel failed"));
  expect(() => f.downloads.approve(id)).toThrow(
    "Download approval failed during cleanup",
  );
  expect(active.decisions).toEqual([
    true,
  ]);
  expect(active.cancelled).toBe(1);
  expect(active.disposed).toBe(0);
  const peer = resource();
  const peerId = f.offer(peer);
  if (!peerId) {
    throw new Error("Missing peer");
  }
  f.downloads.approve(peerId);
  expect(() => f.downloads.dispose()).toThrow("Download cleanup failed");
  expect(active.disposed).toBe(0);
  expect(peer.disposed).toBe(1);
  active.failCancel();
  f.downloads.dispose();
  expect(active.disposed).toBe(1);
  expect(() => f.downloads.dispose()).not.toThrow();
});

test("native UI pause/resume and interruption reasons determine the current paused state", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = f.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  f.downloads.pause(id);
  expect(f.downloads.list()[0]?.paused).toBe(true);
  active.native.resume(); // Browser UI, without calling the backend resume method.
  expect(f.downloads.list()[0]).toMatchObject({
    state: "inProgress",
    paused: false,
  });
  f.downloads.pause(id);
  expect(f.downloads.list()[0]?.paused).toBe(true);
  active.state.interruptReason = 12; // NETWORK_FAILED, unrelated to a user pause.
  expect(f.downloads.list()[0]?.paused).toBe(false);
  active.state.state = "completed";
  active.state.interruptReason = 28;
  expect(f.downloads.list()[0]).toMatchObject({
    state: "completed",
    paused: false,
  });
  f.downloads.dispose();
});

test("encoded metadata limits include JSON escapes, non-ASCII text and retained expired records", async () => {
  const f = fixture(0);
  f.downloads.setRequestsEnabled(true);
  for (const value of [
    "\u0000".repeat(MAX_DOWNLOAD_METADATA_BYTES / 6),
    "😀".repeat(MAX_DOWNLOAD_METADATA_BYTES / 4),
  ]) {
    const item = resource();
    item.state.contentDisposition = value;
    expect(f.offer(item)).toBeNull();
    expect(item.decisions).toEqual([
      false,
    ]);
    expect(item.disposed).toBe(1);
  }
  const expired: Promise<void>[] = [];
  for (let i = 0; i < MAX_WEBVIEW_DOWNLOADS; i++) {
    const item = resource();
    item.state.contentDisposition = "a".repeat(40 * 1024);
    const decide = item.native.decide;
    let decided: () => void = () => {};
    const completion = new Promise<void>((done) => {
      decided = done;
    });
    item.native.decide = (allow) => {
      decide(allow);
      decided();
    };
    if (f.offer(item)) {
      expired.push(completion);
    } else {
      expect(item.disposed).toBe(1);
    }
  }
  expect(expired.length).toBeGreaterThan(0);
  expect(expired.length).toBeLessThan(MAX_WEBVIEW_DOWNLOADS);
  await Promise.all(expired);
  const records = f.downloads.list();
  expect(records.every((item) => item.state === "cancelled")).toBe(true);
  expect(isDownloadSnapshotWithinLimits(records)).toBe(true);
  expect(
    new TextEncoder().encode(JSON.stringify(records)).byteLength,
  ).toBeLessThan(MAX_DOWNLOAD_SNAPSHOT_BYTES);
  const identifier = "a".repeat(128);
  const frame = serializeProcessFrame({
    ipc: {
      major: 1,
      minor: 0,
    },
    runtime: {
      id: identifier,
      generation: identifier,
    },
    kind: "host-response",
    context: identifier,
    requestId: identifier,
    payload: {
      kind: "result",
      payload: records,
    },
  });
  const message = serializeMessage({
    kind: "result",
    protocol: {
      major: 1,
      minor: 0,
    },
    id: identifier,
    payload: records,
  });
  expect(new TextEncoder().encode(frame).byteLength).toBeLessThan(
    MAX_MESSAGE_BYTES,
  );
  expect(new TextEncoder().encode(message).byteLength).toBeLessThan(
    MAX_MESSAGE_BYTES,
  );
  const extra = resource();
  extra.state.contentDisposition = "a".repeat(40 * 1024);
  expect(f.offer(extra)).toBeNull(); // Expired records still reserve their full metadata budget.
  f.downloads.forget(records[0]?.id ?? "");
  expect(f.offer(resource())).not.toBeNull();
  f.downloads.dispose();
});

test("oversized metadata updates never replace a bounded snapshot or lose cancellation authority", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = f.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  const path = active.state.path;
  active.state.path = "x".repeat(MAX_DOWNLOAD_METADATA_BYTES);
  expect(() => f.downloads.list()).toThrow(
    "Download metadata exceeds the snapshot budget",
  );
  expect(active.disposed).toBe(0);
  f.downloads.cancel(id);
  expect(active.cancelled).toBe(1);
  expect(active.disposed).toBe(1);
  expect(f.downloads.list()[0]).toMatchObject({
    path,
    state: "cancelled",
  });
  f.downloads.dispose();
});

test("cancelled snapshots clear a native USER_CANCELED interruption reason", () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = f.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  f.downloads.pause(id);
  expect(f.downloads.list()[0]?.interruptReason).toBe(28);
  f.downloads.cancel(id);
  expect(active.state.interruptReason).toBe(26);
  expect(f.downloads.list()[0]).toMatchObject({
    state: "cancelled",
    paused: false,
    interruptReason: null,
  });
  f.downloads.dispose();
});

test("download cleanup failures are typed and rate-limited per closing owner until exhaustion", () => {
  const owner = fixture();
  owner.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = owner.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  owner.downloads.approve(id);
  active.failCancel(new Error("Transient Cancel failure"));
  expect(() => owner.downloads.dispose()).toThrow(DownloadCleanupError);
  expect(active.disposed).toBe(0);
  let now = 0;
  const retries = new DownloadCleanupRetries(100, () => now);
  const peer = new DownloadCleanupRetries(100, () => now);
  expect(retries.failed()).toBe("retry");
  expect(retries.canAttempt()).toBe(false);
  expect(peer.canAttempt()).toBe(true);
  now = 49;
  expect(retries.canAttempt()).toBe(false);
  now = 50;
  expect(retries.canAttempt()).toBe(true);
  expect(retries.failed()).toBeUndefined();
  now = 100;
  expect(retries.failed()).toBe("timeout");
  now = 150;
  expect(retries.canAttempt()).toBe(false);
  expect(retries.canAttempt(true)).toBe(true);
  expect(active.disposed).toBe(0);
  active.failCancel();
  owner.downloads.dispose();
  expect(active.disposed).toBe(1);
});

/** Let queued zero-delay reports run. */
const settle = () => Bun.sleep(5);

test("a request, its approval and its completion are each reported once, in order", async () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const item = resource();
  const id = f.offer(item);
  if (!id) {
    throw new Error("Missing request");
  }
  await settle();
  expect(f.reports.map((report) => report.state)).toEqual([
    "pending",
  ]);
  f.downloads.approve(id);
  await settle();
  expect(f.reports.map((report) => report.state)).toEqual([
    "pending",
    "inProgress",
  ]);
  item.state.receivedBytes = 100;
  item.state.state = "completed";
  item.notify?.("state");
  // Native duplicates of a delivered state add nothing.
  item.notify?.("state");
  await settle();
  expect(
    f.reports.map((report) => [
      report.state,
      report.receivedBytes,
    ]),
  ).toEqual([
    [
      "pending",
      0,
    ],
    [
      "inProgress",
      0,
    ],
    [
      "completed",
      100,
    ],
  ]);
  // Completion released the operation, and a later native event is not followed up.
  expect(item.disposed).toBe(1);
  expect(item.notify).toBeUndefined();
  expect(f.failures).toEqual([]);
  f.downloads.dispose();
});

test("progress is merged per interval while a state change is reported at once", async () => {
  const f = fixture(30_000, 40);
  f.downloads.setRequestsEnabled(true);
  const item = resource();
  const id = f.offer(item);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  await settle();
  const before = f.reports.length;
  for (const received of [
    10,
    20,
    30,
  ]) {
    item.state.receivedBytes = received;
    item.notify?.("progress");
  }
  // The burst waits out the interval, then reports only the latest count.
  expect(f.reports.length).toBe(before);
  await waitFor(() => (f.reports.length > before ? true : undefined), {
    deadline: "inProcess",
    what: "the merged progress report",
  });
  expect(f.reports.slice(before).map((report) => report.receivedBytes)).toEqual(
    [
      30,
    ],
  );
  // A pause arriving inside the next interval is not delayed by pending progress.
  item.state.receivedBytes = 40;
  item.notify?.("progress");
  item.state.state = "interrupted";
  item.state.canResume = true;
  item.state.interruptReason = 28;
  item.notify?.("state");
  await settle();
  expect(f.reports.at(-1)).toMatchObject({
    state: "interrupted",
    paused: true,
    receivedBytes: 40,
  });
  f.downloads.dispose();
});

test("a state read by an API call is still reported once to subscribers", async () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const item = resource();
  const id = f.offer(item);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  await settle();
  item.state.receivedBytes = 100;
  item.state.state = "completed";
  // list() observes completion and releases the operation before any native event is handled.
  expect(f.downloads.list()[0]?.state).toBe("completed");
  await settle();
  expect(f.reports.at(-1)).toMatchObject({
    state: "completed",
    receivedBytes: 100,
  });
  f.downloads.dispose();
});

test("cancellation and approval expiry are reported as cancelled", async () => {
  const f = fixture(5);
  f.downloads.setRequestsEnabled(true);
  const expired = resource();
  f.offer(expired);
  await waitFor(
    () =>
      f.reports.some((report) => report.state === "cancelled")
        ? true
        : undefined,
    {
      deadline: "inProcess",
      what: "the expiry report",
    },
  );
  const g = fixture();
  g.downloads.setRequestsEnabled(true);
  const active = resource();
  const id = g.offer(active);
  if (!id) {
    throw new Error("Missing request");
  }
  g.downloads.approve(id);
  g.downloads.cancel(id);
  await settle();
  expect(g.reports.at(-1)).toMatchObject({
    state: "cancelled",
    canResume: false,
  });
  expect(active.notify).toBeUndefined();
  f.downloads.dispose();
  g.downloads.dispose();
});

test("forgetting, closing and a failed read send nothing misleading", async () => {
  const f = fixture();
  f.downloads.setRequestsEnabled(true);
  const finished = resource();
  const id = f.offer(finished);
  if (!id) {
    throw new Error("Missing request");
  }
  f.downloads.approve(id);
  finished.state.state = "completed";
  finished.state.receivedBytes = 100;
  await settle();
  const count = f.reports.length;
  f.downloads.forget(id);
  await settle();
  expect(f.reports.length).toBe(count);

  const open = resource();
  const openId = f.offer(open);
  if (!openId) {
    throw new Error("Missing request");
  }
  f.downloads.approve(openId);
  await settle();
  const beforeClose = f.reports.length;
  // Closing cancels the operation, but a closing WebView reports no further changes.
  f.downloads.dispose();
  await settle();
  expect(f.reports.length).toBe(beforeClose);
  open.notify?.("state");
  await settle();
  expect(f.reports.length).toBe(beforeClose);

  const g = fixture();
  g.downloads.setRequestsEnabled(true);
  const failing = resource();
  const failingId = g.offer(failing);
  if (!failingId) {
    throw new Error("Missing request");
  }
  g.downloads.approve(failingId);
  await settle();
  failing.failRead(new Error("native read failed"));
  failing.notify?.("state");
  await settle();
  // A failed read in a native event is routed to the owner, like an expiry that cannot cancel.
  expect(g.failures).toHaveLength(1);
  g.downloads.dispose();
});
