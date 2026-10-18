import { dlopen } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import type { AccessibilityState } from "#appearance/contract";

/** The UI Automation client probe, loaded separately from the always-present system libraries. */
export type UiaProbe = {
  clientsAreListening(): boolean;
  close(): void;
};

/** Load uiautomationcore.dll and bind `UiaClientsAreListening` (no arguments, BOOL result). */
export function loadUiaProbe(): UiaProbe {
  const library = dlopen("uiautomationcore.dll", {
    UiaClientsAreListening: {
      args: [],
      returns: "i32",
    },
  });
  return {
    clientsAreListening: () => library.symbols.UiaClientsAreListening() !== 0,
    close: () => library.close(),
  };
}

/**
 * Combine the screen reader setting flag with the lazily loaded UI Automation probe.
 * The library loads on the first query so Windows builds without it still serve
 * preferences and themes; only this query then fails with UNSUPPORTED.
 */
export function createAccessibilityStateReader(options: {
  screenReaderEnabled(): boolean;
  loadProbe(): UiaProbe;
}) {
  let probe: UiaProbe | undefined;
  let disposed = false;
  return {
    read(): AccessibilityState {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Appearance adapter is disposed.",
        });
      }
      if (!probe) {
        try {
          probe = options.loadProbe();
        } catch {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message:
              "This Windows version cannot report UI Automation client activity.",
          });
        }
      }
      return {
        screenReaderEnabled: options.screenReaderEnabled(),
        assistiveTechnologyActive: probe.clientsAreListening(),
      };
    },
    /** Safe to repeat; releases the probe library only if a query loaded it. */
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      probe?.close();
      probe = undefined;
    },
  };
}
