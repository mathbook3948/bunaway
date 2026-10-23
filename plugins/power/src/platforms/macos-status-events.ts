import { dlopen, JSCallback } from "bun:ffi";
import { failWithCleanup, ResourceOwner } from "@bunaway/plugin";
import { COREFOUNDATION, COREFOUNDATION_PATH } from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import type { PowerStatus } from "#power/contract";

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
const UTF8_ENCODING = 0x08000100;
/** The mode the host pumps; run loop modes are matched by their name. */
const RUN_LOOP_MODE = "kCFRunLoopDefaultMode";

type StatusEmitter = {
  emit(event: "power.statusChanged", payload: PowerStatus): void;
};

const closeLibrary = (library: { close(): void }) => library.close();

/**
 * Emit `power.statusChanged` when the power status differs from the last observed one.
 *
 * `read` is called once as the baseline and again on every power source notification. Equal
 * snapshots are skipped, so the event reports only differences visible to `power.getStatus`. A
 * failing read is reported and keeps the baseline, and the next notification retries it. When
 * the baseline read itself fails, the first successful read is emitted, because nothing is known
 * to compare it with. A failing baseline must not fail the adapter, which still serves queries.
 * Returns the function the notification calls.
 */
export function createStatusPublisher(
  read: () => PowerStatus,
  events: StatusEmitter,
): () => void {
  let lastPublished: string | undefined;
  try {
    lastPublished = JSON.stringify(read());
  } catch (error) {
    console.error("Could not read the initial power status.", error);
  }
  return () => {
    try {
      const next = read();
      const serialized = JSON.stringify(next);
      if (serialized === lastPublished) {
        return;
      }
      events.emit("power.statusChanged", next);
      lastPublished = serialized;
    } catch (error) {
      // A native callback has no caller to throw to, so the failure is reported here.
      console.error("Could not emit power.statusChanged.", error);
    }
  };
}

/**
 * Observe IOKit power source notifications with a run loop source, re-read the status on each one
 * and emit `power.statusChanged` for each difference from the last status.
 *
 * The source is added to the main run loop, which the host pumps in its default mode, so it must
 * run on the macOS main thread. The returned release removes the source before it frees it and
 * closes the callback, so no notification reaches a closed callback, and it is safe to call
 * repeatedly. Low Power Mode changes are not a power source notification and are first seen with
 * the next one. Returns undefined when the host provides no event service.
 */
export function watchMacosPowerStatus(
  read: () => PowerStatus,
  events?: StatusEmitter,
): (() => void) | undefined {
  if (!events) {
    return undefined;
  }
  const owner = new ResourceOwner("macOS power status cleanup failed.");
  try {
    watch(owner, read, events);
  } catch (error) {
    // No caller receives the release function, so undo what was registered before the failure.
    failWithCleanup(
      error,
      () => owner.dispose(),
      "macOS power status cleanup failed.",
    );
  }
  return () => owner.dispose();
}

function watch(
  owner: ResourceOwner,
  read: () => PowerStatus,
  events: StatusEmitter,
): void {
  const core = owner.acquire(
    () =>
      dlopen(COREFOUNDATION_PATH, {
        ...pick(COREFOUNDATION, "CFRelease", "CFStringCreateWithCString"),
        CFRunLoopGetMain: {
          args: [],
          returns: "ptr",
        },
        CFRunLoopAddSource: {
          args: [
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "void",
        },
        CFRunLoopRemoveSource: {
          args: [
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "void",
        },
        CFRunLoopSourceInvalidate: {
          args: [
            "ptr",
          ],
          returns: "void",
        },
      } as const),
    closeLibrary,
  );
  const iokit = owner.acquire(
    () =>
      dlopen(IOKIT, {
        IOPSNotificationCreateRunLoopSource: {
          args: [
            "ptr",
            "ptr",
          ],
          returns: "ptr",
        },
      } as const),
    closeLibrary,
  );
  const publish = createStatusPublisher(read, events);
  const callback = owner.acquire(
    () =>
      new JSCallback(
        () => {
          if (!owner.disposed) {
            publish();
          }
        },
        {
          args: [
            "ptr",
          ],
          returns: "void",
        } as const,
      ),
    closeLibrary,
  );
  const mode = owner.acquire(
    () =>
      core.symbols.CFStringCreateWithCString(
        null,
        RUN_LOOP_MODE,
        UTF8_ENCODING,
      ),
    (string) => {
      if (string) {
        core.symbols.CFRelease(string);
      }
    },
  );
  const source = owner.acquire(
    () => iokit.symbols.IOPSNotificationCreateRunLoopSource(callback.ptr, null),
    (created) => {
      if (created) {
        core.symbols.CFRunLoopSourceInvalidate(created);
        core.symbols.CFRelease(created);
      }
    },
  );
  const runLoop = core.symbols.CFRunLoopGetMain();
  if (!(mode && source && runLoop)) {
    throw new Error("macOS power source notification is unavailable.");
  }
  core.symbols.CFRunLoopAddSource(runLoop, source, mode);
  owner.acquire(
    () => source,
    (added) => core.symbols.CFRunLoopRemoveSource(runLoop, added, mode),
  );
}
