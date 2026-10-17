import { expect, test } from "bun:test";
import { createRecentDocuments } from "#plugins/opener/src/platforms/windows-recent";

test("an already aborted signal or a disposed opener fails before any helper thread starts", () => {
  const OriginalWorker = globalThis.Worker;
  let created = 0;
  globalThis.Worker = class extends OriginalWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      created += 1;
      super(...args);
    }
  };
  try {
    const recent = createRecentDocuments();
    const aborted = AbortSignal.abort();
    expect(() => recent.add("C:\\docs\\report.txt", aborted)).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
    expect(() => recent.clear(aborted)).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
    recent.dispose();
    recent.dispose();
    expect(() => recent.clear()).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
    expect(created).toBe(0);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});
