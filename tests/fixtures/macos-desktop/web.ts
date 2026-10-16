import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

/**
 * Page for tests/lifecycle/macos-desktop.ts. The role is the file name (`main.html`, `observer.html`).
 * `main` answers `windows.closeRequested` and, in `close-lifecycle`, declines its first close after
 * the backend and the observer probed the pending request. `observer` reports `windows.lifecycle`
 * events and tries to answer a close request it does not own.
 */
const client = createClient();
await client.ready;
// The test tsconfig has no DOM library; the page itself always has a location.
const { pathname } = (
  globalThis as unknown as {
    location: URL;
  }
).location;
const role = pathname.slice(1, -".html".length);
const POLL_MS = 50;
const POLL_LIMIT = 200;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Reads one string or number field of an event payload that the host already validated. */
function field(payload: unknown, name: string): string {
  const value =
    typeof payload === "object" && payload !== null
      ? Reflect.get(payload, name)
      : undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Event payload has no ${name}.`);
  }
  return String(value);
}

/** Error code of a failed call, as a log-safe token. */
function codeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string"
    ? code.replaceAll(/[^A-Za-z0-9_-]/g, "_")
    : "UNKNOWN";
}

/** Log lines keep the order of the events that caused them. */
let logged: Promise<unknown> = Promise.resolve();
function log(line: string): Promise<unknown> {
  logged = logged.then(() => client.invoke("test.log", line));
  return logged;
}
function logFailure(error: unknown) {
  void log(`page-failed:${String(error).replaceAll(/[^A-Za-z0-9:_-]/g, "_")}`);
}

const scenario = await client.invoke("test.scenario", null);

if (role === "main") {
  let requests = 0;
  await client.listen(
    "windows.closeRequested",
    (event) => {
      const windowId = field(event.payload, "windowId");
      const viewId = field(event.payload, "viewId");
      const requestId = Number(field(event.payload, "requestId"));
      requests++;
      const allow = !(scenario === "close-lifecycle" && requests === 1);
      void (async () => {
        if (!allow) {
          await log(`declining:${viewId}`);
          // The backend probes the pending request and waits for the observer to do the same.
          await client.invoke("test.pendingClose", requestId);
        }
        await windows.respondClose({
          view: viewId,
          windowId,
          requestId,
          allow,
        });
        if (!allow) {
          await log(`answered:${viewId}:decline`);
        }
      })().catch(logFailure);
    },
    {
      onError: console.error,
    },
  );
  if (scenario === "quit-veto") {
    // After the backend vetoed the quit, the page must still reach it.
    void (async () => {
      while (!(await client.invoke("test.vetoed", null))) {
        await sleep(POLL_MS);
      }
      await client.invoke("test.scenario", null);
      await log("pageRoundTrip:quit-veto");
    })().catch(logFailure);
  }
} else {
  await client.listen(
    "windows.lifecycle",
    (event) => {
      void log(
        `lifecycle:${field(event.payload, "phase")}:${field(event.payload, "viewId")}`,
      ).catch(logFailure);
    },
    {
      onError: console.error,
    },
  );
  if (scenario === "close-lifecycle") {
    // Only the asked window may answer its close request, whatever the policy of this window allows.
    void (async () => {
      let requestId = 0;
      for (
        let attempt = 0;
        requestId === 0 && attempt < POLL_LIMIT;
        attempt++
      ) {
        requestId = Number(await client.invoke("test.pendingRequest", null));
        if (requestId === 0) {
          await sleep(POLL_MS);
        }
      }
      const outcome = await windows
        .respondClose({
          view: "main",
          requestId,
          allow: true,
        })
        .then(
          () => "RESOLVED",
          (error: unknown) => codeOf(error),
        );
      await log(`observerRespond:${outcome}`);
    })().catch(logFailure);
  }
}
await log(`page:${role}`);
