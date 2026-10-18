import { expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import createOperationsDefinition from "#plugins/opener/src/index";
import { createUrlHandlerQuery } from "#plugins/opener/src/platforms/windows-handler";
import { MAX_HANDLER_TEXT_UNITS } from "#plugins/opener/src/platforms/windows-handler-query";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

/** True when the text is non-empty, bounded and free of control characters. */
function isCleanText(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    text.length < MAX_HANDLER_TEXT_UNITS &&
    !/\p{Cc}/u.test(text)
  );
}

test.skipIf(process.platform !== "win32")(
  "getUrlHandler reports a structurally valid https handler or null and rejects invalid URLs",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-opener-handler-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const adapter = createOperations({
      dataRoot: await realpath(root),
      capabilities: [],
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // The registered browser depends on the machine, so only the shape is asserted.
        const handler = (await adapter.execute(
          "opener.getUrlHandler",
          {
            url: "https://example.com/",
          },
          "backend",
        )) as null | Record<string, unknown>;
        if (handler !== null) {
          expect(isCleanText(handler.name)).toBe(true);
          expect(isCleanText(handler.path)).toBe(true);
        }
      }
      for (const url of [
        "file:///C:/Windows/notepad.exe",
        "javascript:alert(1)",
        "not a url",
        " https://example.com/",
      ]) {
        await expect(
          adapter.execute(
            "opener.getUrlHandler",
            {
              url,
            },
            "backend",
          ),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      }
    } finally {
      await adapter.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "the Shell query reports no association as null and rejects use after dispose",
  () => {
    const query = createUrlHandlerQuery();
    try {
      expect(query.query(`bunaway-no-such-scheme-${crypto.randomUUID()}`)).toBe(
        null,
      );
      const https = query.query("https");
      if (https !== null) {
        expect(isCleanText(https.name)).toBe(true);
        expect(isCleanText(https.path)).toBe(true);
      }
    } finally {
      query.dispose();
      query.dispose();
    }
    expect(() => query.query("https")).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
  },
);
