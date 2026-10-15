import { BunawayError, type JsonValue } from "@bunaway/protocol";
import {
  MAX_ACTIVE_TOASTS,
  type NotificationResult,
  type ResolvedNotification,
  type ToastEvent,
} from "#notification/contract";

/** Native resources for one toast. detach must be safe to retry after partial cleanup. */
export type ToastHandle = {
  detach(): void;
};
/** App-scoped driver. Native callbacks must copy arguments before returning to Windows. */
export type ToastDriver = {
  show(
    input: ResolvedNotification,
    receive: (event: ToastEvent) => void,
  ): ToastHandle;
  clear(identity: NotificationResult): void;
  dispose(): void;
};

/** Own live callback generations and clear session toasts before releasing the native driver. */
export function createToastController(
  driver: ToastDriver,
  publish: (event: string, payload: JsonValue) => void,
) {
  type Entry = {
    input: ResolvedNotification;
    handle?: ToastHandle;
    active: boolean;
  };
  const entries = new Map<string, Entry>();
  const retired = new Set<ToastHandle>();
  let stopping = false;
  let disposed = false;
  const key = ({ id, group }: NotificationResult) => `${group}/${id}`;
  const active = () => {
    if (stopping) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Toast adapter is stopping.",
      });
    }
  };
  const drain = () => {
    for (const handle of retired) {
      handle.detach();
      retired.delete(handle);
    }
  };
  const retire = (entry: Entry) => {
    entry.active = false;
    if (entry.handle) {
      retired.add(entry.handle);
    }
  };
  return {
    show(input: ResolvedNotification): NotificationResult {
      active();
      drain();
      const identity = {
        id: input.id,
        group: input.group,
      };
      const id = key(identity);
      const previous = entries.get(id);
      if (!previous && entries.size >= MAX_ACTIVE_TOASTS) {
        throw new BunawayError({
          code: "BUSY",
          message: "Clear an active notification before showing another.",
        });
      }
      const entry: Entry = {
        input: structuredClone(input),
        active: true,
      };
      // Deferred callbacks cannot attribute an old toast's events to its replacement.
      entry.handle = driver.show(input, (event) => {
        if (stopping || !entry.active || entries.get(id) !== entry) {
          return;
        }
        if (event.kind === "clicked") {
          publish("notification.clicked", {
            ...identity,
            data: entry.input.data,
          });
        } else if (event.kind === "dismissed") {
          publish("notification.dismissed", {
            ...identity,
            reason: event.reason,
          });
        } else {
          publish("notification.failed", {
            ...identity,
            hresult: event.hresult,
          });
        }
      });
      entries.set(id, entry);
      if (previous) {
        retire(previous);
      }
      // Keep retired ownership if revocation is still pending. The next operation or dispose retries it.
      // Show has already succeeded, so cleanup must not turn its acknowledgement into an ambiguous failure.
      try {
        drain();
      } catch {
        /* Retained in retired until the next explicit operation. */
      }
      return identity;
    },
    clear(identity: NotificationResult): null {
      active();
      drain();
      // This also clears a matching history item from an earlier process, without clearing other app items.
      driver.clear(identity);
      const id = key(identity);
      const entry = entries.get(id);
      if (entry) {
        retire(entry);
        entries.delete(id);
      }
      drain();
      return null;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      stopping = true;
      const failures: unknown[] = [];
      for (const [id, entry] of entries) {
        entry.active = false;
        try {
          driver.clear(entry.input);
          retire(entry);
          entries.delete(id);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        drain();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Toast cleanup failed.");
      }
      driver.dispose();
      disposed = true;
    },
  };
}

/** Build text-only XML; caller data is never treated as markup, a URI or an executable activation route. */
export function toastXml(input: ResolvedNotification): string {
  const escapeXml = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  return `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(input.title)}</text><text>${escapeXml(input.body)}</text></binding></visual>${input.silent ? '<audio silent="true"/>' : ""}</toast>`;
}
