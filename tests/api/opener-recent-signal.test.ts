import { expect, test } from "bun:test";
import {
  addRecentDocument,
  clearRecentDocuments,
  type initialize,
} from "#plugins/opener/src/platforms/windows";

// Both requests fail on a disposed adapter or an aborted signal before touching the
// Shell or the file system, so a state without native resources is enough here.
const state = {
  disposed: false,
} as unknown as ReturnType<typeof initialize>;

test("an already aborted signal cancels Recent Items requests before any native call", () => {
  const aborted = AbortSignal.abort();
  expect(() =>
    addRecentDocument(state, "C:\\docs\\report.txt", aborted),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(() => clearRecentDocuments(state, aborted)).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("a disposed adapter rejects Recent Items requests", () => {
  const disposed = {
    disposed: true,
  } as unknown as ReturnType<typeof initialize>;
  expect(() => addRecentDocument(disposed, "C:\\docs\\report.txt")).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(() => clearRecentDocuments(disposed)).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});
