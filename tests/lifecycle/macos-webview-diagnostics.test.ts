import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_LOAD_RETRIES,
  PROVISIONAL_STALL_MS,
  StalledLoadClock,
  stalledLoadAction,
  WebviewDiagnostics,
  webviewError,
} from "#native/macos/bun/webview-diagnostics";

test("a probe is written flat into its stage record next to the stage fields", () => {
  const records: object[] = [];
  const diagnostics = new WebviewDiagnostics((event, fields) => {
    records.push({
      event,
      ...fields,
    });
  });
  diagnostics.record("load-retried", {
    progress: 0.1,
    probe: {
      viewIndex: 1,
      sinceViewMs: 3100,
      sinceProcessMs: 5200,
      contentPid: null,
      pool: "a",
      store: "b",
      loading: true,
      progress: 0.1,
      hasUrl: false,
      windowVisible: true,
      windowOccluded: false,
      viewHidden: false,
      policyCalls: 1,
      assetStarts: 0,
    },
  });
  expect(records[0]).toMatchObject({
    event: "webview-stage",
    stage: "load-retried",
    progress: 0.1,
    viewIndex: 1,
    contentPid: null,
    loading: true,
    policyCalls: 1,
  });
  expect(records[0]).not.toHaveProperty("probe");
});

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

test("reissued loads without a policy callback keep retrying and end in one report", () => {
  const clock = new StalledLoadClock();
  clock.requested();
  expect(clock.check(10_000)).toBe("wait");
  clock.policyAllowed(10_000);
  expect(clock.check(10_000 + PROVISIONAL_STALL_MS - 1)).toBe("wait");
  const actions: string[] = [];
  let now = 10_000;
  // After the first reissue no policy callback arrives again: only the clock drives the rest.
  for (let step = 0; step < MAX_LOAD_RETRIES + 2; step++) {
    now += PROVISIONAL_STALL_MS;
    actions.push(clock.check(now));
    expect(clock.check(now + PROVISIONAL_STALL_MS - 1)).toBe(
      actions.at(-1) === "retry" ? "wait" : "none",
    );
  }
  expect(actions).toEqual([
    "retry",
    "retry",
    "retry",
    "report",
    "none",
  ]);
});

test("the request that follows a retry keeps the restarted clock, a new request clears it", () => {
  const clock = new StalledLoadClock();
  clock.requested();
  clock.policyAllowed(0);
  expect(clock.check(PROVISIONAL_STALL_MS)).toBe("retry");
  clock.requested();
  expect(clock.check(PROVISIONAL_STALL_MS * 2)).toBe("retry");
  clock.requested();
  expect(clock.check(PROVISIONAL_STALL_MS * 3)).toBe("retry");
  expect(clock.check(PROVISIONAL_STALL_MS * 4)).toBe("report");
  clock.resetBudget();
  clock.requested();
  expect(clock.check(PROVISIONAL_STALL_MS * 5)).toBe("wait");
});

test("a late policy decision does not move the clock of a reissued load", () => {
  const clock = new StalledLoadClock();
  clock.requested();
  clock.policyAllowed(0);
  expect(clock.check(PROVISIONAL_STALL_MS)).toBe("retry");
  clock.policyAllowed(PROVISIONAL_STALL_MS + 2000);
  expect(clock.check(PROVISIONAL_STALL_MS * 2)).toBe("retry");
});

test("a reload after a crash waits for its policy decision and gets a new budget", () => {
  const clock = new StalledLoadClock();
  clock.requested();
  clock.policyAllowed(0);
  for (let step = 1; step <= MAX_LOAD_RETRIES + 1; step++) {
    clock.check(PROVISIONAL_STALL_MS * step);
  }
  clock.resetBudget();
  clock.requested();
  expect(clock.check(PROVISIONAL_STALL_MS * 10)).toBe("wait");
  clock.policyAllowed(PROVISIONAL_STALL_MS * 10);
  expect(clock.check(PROVISIONAL_STALL_MS * 11)).toBe("retry");
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

test("the stalled-load test hooks are reachable only from the constructor argument no production code passes", () => {
  const directory = resolve(import.meta.dir, "../../native/macos/bun");
  const users = readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) =>
      /stallLoad|WebviewTestHooks/.test(
        readFileSync(resolve(directory, name), "utf8"),
      ),
    );
  expect(users).toEqual([
    "webview.ts",
  ]);
  const creator = readFileSync(resolve(directory, "windows.ts"), "utf8");
  expect(creator).not.toMatch(/testHooks|stallLoad/);
});

test("a clock started without a policy decision still retries and reports", () => {
  const clock = new StalledLoadClock();
  clock.startNow(0);
  // The load that follows keeps the start instead of waiting for a policy decision.
  clock.requested();
  expect(clock.check(PROVISIONAL_STALL_MS - 1)).toBe("wait");
  const actions: string[] = [];
  for (let step = 1; step <= MAX_LOAD_RETRIES + 2; step++) {
    const action = clock.check(step * PROVISIONAL_STALL_MS);
    actions.push(action);
    if (action === "retry") {
      clock.requested();
    }
  }
  expect(actions).toEqual([
    "retry",
    "retry",
    "retry",
    "report",
    "none",
  ]);
});
