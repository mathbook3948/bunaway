import { defineNativePlugin } from "@bunaway/plugin";
import type { Pasteboard } from "../../plugins/clipboard/src/macos-pasteboard.ts";
import { macosOperations as clipboardOperations } from "../../plugins/clipboard/src/operations.ts";
import {
  dispose as disposeClipboard,
  MacosClipboard,
} from "../../plugins/clipboard/src/platforms/macos.ts";
import { globalShortcutOperations } from "../../plugins/global-shortcut/src/operations.ts";
import { initializeShortcutOperations } from "../../plugins/global-shortcut/src/shortcut-adapter.ts";
import { macosOperations as openerOperations } from "../../plugins/opener/src/operations.ts";
import {
  createState,
  dispose as disposeOpener,
} from "../../plugins/opener/src/platforms/macos.ts";
import { MacosSafeStorage } from "../../plugins/safe-storage/src/macos-operations.ts";
import { safeStorageOperations } from "../../plugins/safe-storage/src/operations.ts";
import { nativeFactory } from "./native-platform.ts";

const environment = {
  dataRoot: ".",
  capabilities: [],
};

/** Inject only the native driver; parsing, dispatch and lifetime use the production operation map and SDK. */
export function pasteboardOperations(native: Pasteboard) {
  return nativeFactory(
    defineNativePlugin({
      name: "clipboard",
      platforms: {
        macos: {
          initialize: () => new MacosClipboard(native),
          dispose: disposeClipboard,
          operations: clipboardOperations,
        },
      },
    }),
    "macos",
  )(environment);
}

/** Exercise checked file/workspace ownership without launching an external application. */
export function createOpenerAdapter(
  ...providers: Parameters<typeof createState>
) {
  return nativeFactory(
    defineNativePlugin({
      name: "opener",
      platforms: {
        macos: {
          initialize: () => createState(...providers),
          dispose: disposeOpener,
          operations: openerOperations,
        },
      },
    }),
    "macos",
  )(environment);
}

/** Use the real shortcut lifetime with an injected driver and host event sink. */
export function createShortcutOperations(
  ...providers: Parameters<typeof initializeShortcutOperations>
) {
  return nativeFactory(
    defineNativePlugin({
      name: "globalShortcut",
      platforms: {
        windows: {
          initialize: () => initializeShortcutOperations(...providers),
          dispose: (
            instance: ReturnType<typeof initializeShortcutOperations>,
          ) => instance.dispose(),
          operations: globalShortcutOperations,
        },
      },
    }),
    "windows",
  )(environment);
}

/** Use disposable/in-memory Keychain providers with the same protection operations as a packaged host. */
export function macosSafeStorageOperations(
  ...providers: ConstructorParameters<typeof MacosSafeStorage>
) {
  return nativeFactory(
    defineNativePlugin({
      name: "safe-storage",
      platforms: {
        macos: {
          initialize: () => new MacosSafeStorage(...providers),
          dispose: (instance: MacosSafeStorage) => instance.dispose(),
          operations: safeStorageOperations,
        },
      },
    }),
    "macos",
  )(environment);
}
