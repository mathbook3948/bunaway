import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

/**
 * Page for tests/lifecycle/macos-desktop.ts. The page answers `windows.closeRequested` and, in
 * `close-lifecycle`, declines its first close after the backend probed the pending request.
 *
 * Every stage after the handshake logs `page-step:<role>:<step>`, and a failure of any stage logs
 * `page-failed:<role>:<step>:<code>:<details>`, which the harness treats like `script-failed`. A
 * page that never reports `page:<role>` therefore shows where it stopped. A failed handshake cannot
 * be logged by the page, because `test.log` needs a negotiated session: it only reaches
 * `console.error`, and the host log of that scenario (`web-message-rejected`, `revoke`,
 * `request-timeout`) is the evidence. The harness prints its tail when a scenario fails.
 */
const client = createClient();
// The test tsconfig has no DOM library; the page itself always has a location.
const role = "main";
const POLL_MS = 50;
/** Keeps a failure token short enough to read in a CI log. */
const DETAILS_LIMIT = 160;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Stage the page is in, so a failure names where it happened. */
let step = "handshake";

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

/** Replaces everything `test.log` rejects; its input pattern is `^[A-Za-z0-9:_-]+$`. */
function logSafe(text: string): string {
  return text.replaceAll(/[^A-Za-z0-9:_-]/g, "_");
}

/** Error code of a failed call, as a log-safe token. */
function codeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? logSafe(code) : "UNKNOWN";
}

/** Log lines keep the order of the events that caused them; one failed line does not block later ones. */
let logged: Promise<unknown> = Promise.resolve();
function log(line: string): Promise<unknown> {
  logged = logged
    .catch(() => undefined)
    .then(() => client.invoke("test.log", line));
  return logged;
}

/** Enters a stage and records it. */
function enter(name: string): Promise<unknown> {
  step = name;
  return log(`page-step:${role}:${name}`);
}

/** Records a failure of the current stage; `console.error` keeps it when logging is impossible too. */
function logFailure(error: unknown) {
  console.error(`page ${role} failed in ${step}:`, error);
  const details = logSafe(String(error)).slice(0, DETAILS_LIMIT);
  log(`page-failed:${role}:${step}:${codeOf(error)}:${details}`).catch(
    () => undefined,
  );
}

async function listenAsMain(scenario: unknown) {
  let requests = 0;
  await enter("listen-close-requested");
  await client.listen(
    "windows.closeRequested",
    (event) => {
      const viewId = field(event.payload, "viewId");
      const requestId = Number(field(event.payload, "requestId"));
      requests++;
      const allow = !(scenario === "close-lifecycle" && requests === 1);
      void (async () => {
        if (!allow) {
          await log(`declining:${viewId}`);
          // The backend probes the pending request before the page answers.
          await client.invoke("test.pendingClose", requestId);
        }
        await windows.respondClose({
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
    await enter("poll-veto");
    void (async () => {
      while (!(await client.invoke("test.vetoed", null))) {
        await sleep(POLL_MS);
      }
      await client.invoke("test.scenario", null);
      await log("pageRoundTrip:quit-veto");
    })().catch(logFailure);
  }
}

/** Boots the page for its role; each awaited stage reports its own failure through `logFailure`. */
async function run() {
  await client.ready;
  await enter("scenario");
  const scenario = await client.invoke("test.scenario", null);
  await listenAsMain(scenario);
  await enter("report");
  await log(`page:${role}`);
}

run().catch(logFailure);
