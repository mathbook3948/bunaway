import { attemptAll } from "@bunaway/plugin";
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
  /** Hide every toast owned by this driver and clear all history of the host app ID, including earlier processes. */
  clearAll(): void;
  /** Identities of the host app ID's history items, including earlier processes. Items without a valid identity are omitted. */
  list(): NotificationResult[];
  dispose(): void;
};

/** Own live callback generations and clear session toasts before releasing the native driver. */
export function createToastController(
  driver: ToastDriver,
  publish: (event: string, payload: JsonValue) => void,
  // Native STA controllers supply one bounded synchronous settling budget per operation.
  beginSettle: () => (cleanup: () => void) => void = () => (cleanup) =>
    cleanup(),
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
      const settle = beginSettle();
      settle(drain);
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
        settle(drain);
      } catch {
        /* Retained in retired until the next explicit operation. */
      }
      return identity;
    },
    clear(identity: NotificationResult): null {
      active();
      const settle = beginSettle();
      settle(drain);
      // This also clears a matching history item from an earlier process, without clearing other app items.
      driver.clear(identity);
      const id = key(identity);
      const entry = entries.get(id);
      if (entry) {
        retire(entry);
        entries.delete(id);
      }
      settle(drain);
      return null;
    },
    list(): NotificationResult[] {
      active();
      return driver.list();
    },
    clearAll(): null {
      active();
      const settle = beginSettle();
      settle(drain);
      // A driver failure leaves every entry owned so the caller can retry.
      driver.clearAll();
      // Retiring discards late callbacks. Like clear, no synthetic dismissed event is published.
      for (const entry of entries.values()) {
        retire(entry);
      }
      entries.clear();
      settle(drain);
      return null;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      stopping = true;
      attemptAll(
        [
          ...[
            ...entries,
          ].map(([id, entry]) => () => {
            entry.active = false;
            driver.clear(entry.input);
            retire(entry);
            entries.delete(id);
          }),
          drain,
        ],
        "Toast cleanup failed.",
      );
      driver.dispose();
      disposed = true;
    },
  };
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Convert a validated drive-absolute path to file:/// with each segment percent-encoded. */
export function toastFileUri(path: string): string {
  const [drive = "", ...segments] = path.replaceAll("\\", "/").split("/");
  return `file:///${drive}/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Build toast XML. Text and file URIs are escaped, and media paths are validated local files.
 * A looping sound needs duration="long", otherwise Windows plays it once with the short toast.
 * Caller data is never treated as markup or an executable activation route.
 */
export function toastXml(input: ResolvedNotification): string {
  const image = (path: string, placement: string) =>
    `<image ${placement}src="${escapeXml(toastFileUri(path))}"/>`;
  const media = [
    input.icon ? image(input.icon, 'placement="appLogoOverride" ') : "",
    input.image
      ? image(
          input.image,
          input.imagePlacement === "hero" ? 'placement="hero" ' : "",
        )
      : "",
  ].join("");
  let audio = "";
  if (input.silent) {
    audio = '<audio silent="true"/>';
  } else if (input.sound) {
    audio = `<audio src="ms-winsoundevent:Notification.${input.sound}"${input.soundLoop ? ' loop="true"' : ""}/>`;
  }
  return `<toast${input.soundLoop ? ' duration="long"' : ""}><visual><binding template="ToastGeneric">${media}<text>${escapeXml(input.title)}</text><text>${escapeXml(input.body)}</text></binding></visual>${audio}</toast>`;
}
