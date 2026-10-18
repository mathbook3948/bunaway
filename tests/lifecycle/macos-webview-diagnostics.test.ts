import { expect, test } from "bun:test";
import {
  MAX_LOAD_RETRIES,
  PROVISIONAL_STALL_MS,
  stalledLoadAction,
  WebviewDiagnostics,
  webviewError,
} from "#native/macos/bun/webview-diagnostics";

test("WebView stage records stop at a fixed bound with an explicit limit marker", () => {
  const records: object[] = [];
  const diagnostics = new WebviewDiagnostics((event, fields) => {
    records.push({
      event,
      ...fields,
    });
  });
  diagnostics.record("load-returned", {
    accepted: true,
  });
  for (let index = 0; index < 1000; index++) {
    diagnostics.record("asset-started");
  }
  expect(records).toHaveLength(64);
  expect(records[0]).toEqual({
    event: "webview-stage",
    stage: "load-returned",
    accepted: true,
  });
  expect(records.at(-1)).toEqual({
    event: "webview-stage",
    stage: "limit",
  });
});

test("a stalled initial load is reissued a bounded number of times and reported once", () => {
  expect(stalledLoadAction(PROVISIONAL_STALL_MS - 1, 0)).toBe("wait");
  const actions: string[] = [];
  let attempts = 0;
  for (let step = 0; step < MAX_LOAD_RETRIES + 3; step++) {
    const action = stalledLoadAction(PROVISIONAL_STALL_MS, attempts);
    actions.push(action);
    if (action === "retry" || action === "report") {
      attempts++;
    }
  }
  expect(actions).toEqual([
    "retry",
    "retry",
    "retry",
    "report",
    "none",
    "none",
  ]);
});

test("native error diagnostics preserve signed codes and redact unrecognized domains", () => {
  expect(webviewError("NSURLErrorDomain", -999n)).toEqual({
    errorDomain: "NSURLErrorDomain",
    errorCode: -999,
  });
  expect(webviewError("WKErrorDomain", 4)).toEqual({
    errorDomain: "WKErrorDomain",
    errorCode: 4,
  });
  const diagnostic = webviewError(
    "https://user:secret@host/private?token=secret",
    1,
  );
  expect(diagnostic).toEqual({
    errorDomain: "other",
    errorCode: 1,
  });
  expect(JSON.stringify(diagnostic)).not.toContain("secret");
  expect(webviewError("NSCocoaErrorDomain", 2n ** 63n)).toEqual({
    errorDomain: "NSCocoaErrorDomain",
    errorCode: null,
  });
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "real NSError diagnostics read signed NSInteger codes without reading userInfo",
  async () => {
    const { Objc } = await import("#native/macos/bun/objc");
    const objc = new Objc();
    objc.withAutoreleasePool(() => {
      const error = objc.send(
        objc.class("NSError"),
        "errorWithDomain:code:userInfo:",
        objc.string("NSURLErrorDomain"),
        -999n,
        null,
      );
      expect(error).not.toBeNull();
      if (!error) {
        throw new Error("NSError creation failed");
      }
      expect(
        webviewError(
          objc.text(objc.send(error, "domain")),
          objc.integer(error, "code"),
        ),
      ).toEqual({
        errorDomain: "NSURLErrorDomain",
        errorCode: -999,
      });
    });
  },
);
