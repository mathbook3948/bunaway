import { dlopen, ptr } from "bun:ffi";
import { appendFileSync } from "node:fs";
import { Objc, type ObjcObject } from "../../../native/macos/bun/objc.ts";
import { fourCharCode } from "../../../native/macos/bun/quit-reason.ts";

/**
 * Sender of a quit Apple event that waits for the reply, for the `session-end-reply` scenario of
 * tests/lifecycle/macos-desktop.ts. loginwindow addresses the quit event of a logout or shutdown to
 * the app and waits for its reply before it goes on, which is what the host's suspended quit event
 * exists for. The driver plugin cannot show that: an event the app sends to itself, or one sent
 * with `kAENoReply`, never makes anybody wait for the reply, so a host that replied at once would
 * pass as well.
 *
 * It runs as its own `bun` process for two reasons. Only a second process is a real sender for the
 * app, as loginwindow is. And `sendEventWithOptions:` with `kAEWaitReply` blocks the calling thread
 * until the reply arrives, so inside the harness process it would stop the harness's log polling
 * and the other checks while the app cleans up.
 *
 * Usage: `bun quit-event-sender.ts <pid> <quit reason code> <events log path>`
 *
 * After the reply it appends `quit-reply-received` to the app's events log, so the test can order
 * the reply against the app's cleanup lines, and prints one JSON line `{ ok, elapsedMs, errorCode? }`
 * on stdout. The exit code is non-zero when no successful reply arrived. `errorCode` is the
 * `NSError` code of the send (for example -1743 `errAEEventNotPermitted` when the system denies
 * the Automation permission, -609 `connectionInvalid` when the app ended without replying, -1712
 * `errAETimeout`) or the `errn` parameter of a reply that reports an error.
 */

const OBJC = "/usr/lib/libobjc.A.dylib";
/** `kAutoGenerateReturnID` and `kAnyTransactionID` of `AECreateAppleEvent`. */
const AUTO_GENERATE_RETURN_ID = -1;
const ANY_TRANSACTION_ID = 0;
/** `kAEWaitReply` send option: the call returns the reply descriptor once the app answered. */
const AE_WAIT_REPLY = 3;
/** Longer than the host's wait for app cleanup (SESSION_END_WAIT_MS), so a late reply is still a reply. */
const REPLY_TIMEOUT_SECONDS = 10;
/** `keyErrorNumber` parameter that a reply carries when the handler failed. */
const KEY_ERROR_NUMBER = fourCharCode("errn");
const POINTER_BYTES = 8;
const INT32_BITS = 32;

type SendResult = {
  ok: boolean;
  elapsedMs: number;
  errorCode?: number;
};

const [pidText, reason, eventsPath] = process.argv.slice(2);
const pid = Number(pidText);
if (!Number.isInteger(pid) || pid <= 0 || !reason || !eventsPath) {
  console.error(
    "Usage: quit-event-sender.ts <pid> <quit reason code> <events log path>",
  );
  process.exit(2);
}

const o = new Objc();
// Apple event creation takes FourCharCodes and 16-bit ids, sending takes a double timeout and an
// NSError out-parameter; Objc.send passes integer registers only, so these messages get their own
// signatures, as in driver.ts.
const createEvent = dlopen(OBJC, {
  objc_msgSend: {
    args: [
      "ptr",
      "ptr",
      "u32",
      "u32",
      "ptr",
      "i16",
      "i32",
    ],
    returns: "ptr",
  },
});
const sendEvent = dlopen(OBJC, {
  objc_msgSend: {
    args: [
      "ptr",
      "ptr",
      "u64",
      "f64",
      "ptr",
    ],
    returns: "ptr",
  },
});

/** Reads a 32-bit signed result that arrives in a 64-bit register with undefined upper bits. */
function int32Of(value: number | bigint): number {
  return Number(BigInt.asIntN(INT32_BITS, BigInt(value)));
}

/**
 * Sends the quit event to `targetPid` and blocks until the reply. The reply counts as a success
 * when it exists, the send reported no error and the reply has no non-zero `errn` parameter.
 * Runs inside an autorelease pool because every descriptor here is autoreleased.
 */
function sendQuitEvent(targetPid: number, quitReason: string): SendResult {
  const descriptor = o.class("NSAppleEventDescriptor");
  const target = o.send(
    descriptor,
    "descriptorWithProcessIdentifier:",
    targetPid,
  );
  const event = target
    ? createEvent.symbols.objc_msgSend(
        descriptor,
        o.selector(
          "appleEventWithEventClass:eventID:targetDescriptor:returnID:transactionID:",
        ),
        fourCharCode("aevt"),
        fourCharCode("quit"),
        target,
        AUTO_GENERATE_RETURN_ID,
        ANY_TRANSACTION_ID,
      )
    : null;
  if (!target || !event) {
    throw new Error("Apple event creation failed.");
  }
  o.send(
    event,
    "setAttributeDescriptor:forKeyword:",
    o.send(descriptor, "descriptorWithEnumCode:", fourCharCode(quitReason)),
    fourCharCode("why?"),
  );
  // The out-parameter receives an autoreleased NSError* only when the send fails.
  const errorSlot = Buffer.alloc(POINTER_BYTES);
  const startedAt = performance.now();
  const reply = sendEvent.symbols.objc_msgSend(
    event,
    o.selector("sendEventWithOptions:timeout:error:"),
    AE_WAIT_REPLY,
    REPLY_TIMEOUT_SECONDS,
    ptr(errorSlot),
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  const errorAddress = errorSlot.readBigUInt64LE(0);
  if (errorAddress !== 0n) {
    return {
      ok: false,
      elapsedMs,
      errorCode: int32Of(o.integer(errorAddress as ObjcObject, "code")),
    };
  }
  if (!reply) {
    return {
      ok: false,
      elapsedMs,
    };
  }
  const errorNumber = o.send(
    reply,
    "paramDescriptorForKeyword:",
    KEY_ERROR_NUMBER,
  );
  const replyErrorCode = errorNumber
    ? int32Of(o.integer(errorNumber, "int32Value"))
    : 0;
  return replyErrorCode === 0
    ? {
        ok: true,
        elapsedMs,
      }
    : {
        ok: false,
        elapsedMs,
        errorCode: replyErrorCode,
      };
}

let result: SendResult;
try {
  result = o.withAutoreleasePool(() => sendQuitEvent(pid, reason));
  // Logged right after the send returned, so its position among the app's own lines tells whether
  // the app replied after its cleanup. A failure before the send returned is not logged.
  appendFileSync(eventsPath, "quit-reply-received\n");
} catch (error) {
  console.error(String(error));
  result = {
    ok: false,
    elapsedMs: 0,
  };
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
