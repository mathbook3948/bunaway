import { expect, test } from "bun:test";
import {
  MAX_WEBVIEW_DOWNLOADS,
  type WebViewDownload,
} from "@bunaway/plugin-api/native";
import {
  type DownloadResource,
  Downloads,
} from "#native/windows/bun/downloads";

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
  let failure: Error | undefined;
  const native: DownloadResource = {
    read: () => ({
      ...state,
    }),
    decide(allow) {
      decisions.push(allow);
      if (failure) {
        throw failure;
      }
      state.state = allow ? "inProgress" : "interrupted";
    },
    cancel() {
      cancelled++;
    },
    pause() {
      state.state = "interrupted";
      state.canResume = true;
    },
    resume() {
      state.state = "inProgress";
      state.canResume = false;
    },
    dispose() {
      disposed++;
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
    fail: (error: Error) => {
      failure = error;
    },
  };
}

function fixture(timeoutMs = 30_000) {
  const failures: unknown[] = [];
  const downloads = new Downloads(
    (url, source) =>
      url.startsWith("https://app.bunaway.local/") &&
      source.startsWith("https://app.bunaway.local/"),
    timeoutMs,
    (error) => failures.push(error),
  );
  const offer = (
    item: ReturnType<typeof resource>,
    source = "https://app.bunaway.local/index.html",
  ) => downloads.offer(item.native, source);
  return {
    downloads,
    offer,
    failures,
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

test("failed decisions and cleanup retire every resource and report owned failures", async () => {
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
  expect(failed.disposed).toBe(1);
  const failClose = resource();
  failClose.fail(new Error("Native cancel failed"));
  const peer = resource();
  f.offer(failClose);
  f.offer(peer);
  expect(() => f.downloads.dispose()).toThrow("Download cleanup failed");
  expect(failClose.disposed).toBe(1);
  expect(peer.decisions).toEqual([
    false,
  ]);
  expect(peer.disposed).toBe(1);
  expect(() => f.downloads.list()).toThrow();
  expect(() => f.downloads.dispose()).not.toThrow();
});
