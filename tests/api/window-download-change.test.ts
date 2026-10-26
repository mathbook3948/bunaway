import { expect, test } from "bun:test";
import {
  MAX_DOWNLOAD_METADATA_BYTES,
  type WebViewDownload,
  type WindowDownloadChangeEvent,
} from "@bunaway/plugin-api/native";
import { windowDefinitions } from "#plugins/windows/src/contract";
import { DownloadChangeFeed } from "#plugins/windows/src/platforms/lifecycle-feed";

const download: WebViewDownload = {
  id: crypto.randomUUID(),
  url: "https://app.bunaway.local/file.bin",
  mimeType: "application/octet-stream",
  contentDisposition: "",
  path: "C:\\Users\\test\\Downloads\\file.bin",
  totalBytes: 100,
  receivedBytes: 10,
  state: "inProgress",
  interruptReason: null,
  canResume: false,
  paused: false,
};
const change: WindowDownloadChangeEvent = {
  windowId: "w1",
  viewId: "main",
  download,
};

function source() {
  const listeners = new Set<(event: WindowDownloadChangeEvent) => void>();
  return {
    listeners,
    subscribe(listener: (event: WindowDownloadChangeEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: WindowDownloadChangeEvent) {
      for (const listener of [
        ...listeners,
      ]) {
        listener(event);
      }
    },
  };
}

test("the result carries a getDownloads snapshot and rejects extra or oversized data", () => {
  const output = windowDefinitions.waitForDownloadChange.output;
  expect(
    output.safeParse({
      ...change,
      sequence: 1,
    }).success,
  ).toBe(true);
  expect(
    output.safeParse({
      ...change,
      sequence: 1,
      speed: 1,
    }).success,
  ).toBe(false);
  expect(
    output.safeParse({
      ...change,
      sequence: 1,
      download: {
        ...download,
        speed: 1,
      },
    }).success,
  ).toBe(false);
  expect(
    output.safeParse({
      ...change,
      sequence: 1,
      download: {
        ...download,
        url: "x".repeat(MAX_DOWNLOAD_METADATA_BYTES),
      },
    }).success,
  ).toBe(false);
  expect(
    windowDefinitions.waitForDownloadChange.input.safeParse({
      after: -1,
    }).success,
  ).toBe(false);
});

test("a platform without download change notification reports UNSUPPORTED", async () => {
  const feed = new DownloadChangeFeed(undefined);
  await expect(feed.wait(undefined)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("changes are numbered in order and a cursor resumes after the last one seen", async () => {
  const downloads = source();
  const feed = new DownloadChangeFeed(downloads.subscribe);
  const next = feed.wait(undefined);
  downloads.emit(change);
  expect(await next).toEqual({
    ...change,
    sequence: 1,
  });
  downloads.emit({
    ...change,
    download: {
      ...download,
      state: "completed",
      receivedBytes: 100,
    },
  });
  expect(await feed.wait(1)).toMatchObject({
    sequence: 2,
    download: {
      state: "completed",
      receivedBytes: 100,
    },
  });
});

test("disposing the feed removes the host listener", () => {
  const downloads = source();
  const feed = new DownloadChangeFeed(downloads.subscribe);
  expect(downloads.listeners.size).toBe(1);
  feed.dispose();
  expect(downloads.listeners.size).toBe(0);
});
