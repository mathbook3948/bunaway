import { createClient } from "@bunaway/client";
import { PERMISSION_PROBES } from "../windows-webview-permission-report.ts";

/** Each request gets this long; a prompt that never answers is reported instead of hanging the test. */
const REQUEST_TIMEOUT_MS = 8000;

const NO_ANSWER = Symbol("no answer");

const denied = (detail) => ({
  result: "denied",
  detail,
});
const granted = (detail) => ({
  result: "granted",
  detail,
});
const other = (detail) => ({
  result: "other",
  detail,
});

/** A promise API either refuses with a permission error name, succeeds, or fails some other way. */
async function settle(request) {
  try {
    return granted(String(await request()));
  } catch (error) {
    const name = error instanceof Error ? error.name : String(error);
    return name === "NotAllowedError" || name === "SecurityError"
      ? denied(name)
      : other(name);
  }
}

const GEOLOCATION_PERMISSION_DENIED = 1;

function probeGeolocation() {
  if (!navigator.geolocation) {
    return {
      result: "unsupported",
      detail: "",
    };
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve(granted("position")),
      (error) =>
        resolve(
          error.code === GEOLOCATION_PERMISSION_DENIED
            ? denied("PERMISSION_DENIED")
            : other(`code ${error.code}`),
        ),
    );
  });
}

async function probeNotification() {
  if (typeof Notification === "undefined") {
    return {
      result: "unsupported",
      detail: "",
    };
  }
  const answer = await Notification.requestPermission();
  if (answer === "granted") {
    return granted(answer);
  }
  return answer === "denied" ? denied(answer) : other(answer);
}

function probeClipboardRead() {
  if (!navigator.clipboard?.readText) {
    return {
      result: "unsupported",
      detail: "",
    };
  }
  return settle(() => navigator.clipboard.readText());
}

function probeClipboardWrite() {
  if (!navigator.clipboard?.writeText) {
    return {
      result: "unsupported",
      detail: "",
    };
  }
  // The request has no user gesture; whatever the engine answers is recorded as it is.
  return settle(() => navigator.clipboard.writeText("permission probe"));
}

function probeWakeLock() {
  if (!navigator.wakeLock) {
    return {
      result: "unsupported",
      detail: "",
    };
  }
  return settle(async () => {
    const sentinel = await navigator.wakeLock.request("screen");
    await sentinel.release();
    return "screen";
  });
}

function probePointerLock() {
  if (!document.body.requestPointerLock) {
    return {
      result: "unsupported",
      detail: "",
    };
  }
  return new Promise((resolve) => {
    const finish = (outcome) => {
      document.removeEventListener("pointerlockchange", onChange);
      document.removeEventListener("pointerlockerror", onError);
      resolve(outcome);
    };
    const onChange = () => {
      if (document.pointerLockElement) {
        document.exitPointerLock();
        finish(granted("pointerlockchange"));
      }
    };
    const onError = () => finish(denied("pointerlockerror"));
    document.addEventListener("pointerlockchange", onChange);
    document.addEventListener("pointerlockerror", onError);
    // Newer engines also return a promise that rejects; the events above decide the outcome.
    Promise.resolve(document.body.requestPointerLock()).catch((error) =>
      finish(
        error instanceof Error && error.name === "NotAllowedError"
          ? denied(error.name)
          : other(String(error)),
      ),
    );
  });
}

function probeFilePicker() {
  if (typeof window.showOpenFilePicker !== "function") {
    return {
      result: "unsupported",
      detail: "",
    };
  }
  return settle(async () => {
    const handles = await window.showOpenFilePicker();
    return `${handles.length} handles`;
  });
}

const probes = {
  geolocation: probeGeolocation,
  notification: probeNotification,
  clipboardRead: probeClipboardRead,
  clipboardWrite: probeClipboardWrite,
  wakeLock: probeWakeLock,
  pointerLock: probePointerLock,
  filePicker: probeFilePicker,
};

/** Runs one request with a deadline; a request that stays pending is a `timeout`, not a hang. */
async function runWithDeadline(probe) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(NO_ANSWER), REQUEST_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      Promise.resolve()
        .then(probe)
        .catch((error) => other(String(error))),
      deadline,
    ]);
    return answer === NO_ANSWER
      ? {
          result: "timeout",
          detail: `no answer in ${REQUEST_TIMEOUT_MS} ms`,
        }
      : answer;
  } finally {
    clearTimeout(timer);
  }
}

const client = createClient();
await client.ready;
const report = {
  userAgent: navigator.userAgent,
  origin: location.origin,
  probes: {},
};
let previousDenials = 0;
for (const name of PERMISSION_PROBES) {
  const started = performance.now();
  const outcome = await runWithDeadline(probes[name]);
  const ms = Math.round(performance.now() - started);
  // The host counts its refusals in its own log; the difference belongs to this request.
  const { denials } = await client.invoke("test.mark", {});
  report.probes[name] = {
    ...outcome,
    ms,
    hostDenials: denials - previousDenials,
  };
  previousDenials = denials;
}
await client.invoke("test.record", {
  report,
});
await client.invoke("test.finish", null).catch(() => {});
