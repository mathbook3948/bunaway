import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import type { NotificationSetting, NotificationStatus } from "./contract.ts";

const POINTER_BYTES = 8;
const RO_INIT_SINGLETHREADED = 0;
const HRESULT_ACCESS_DENIED = 0x80070005;
const REGDB_E_CLASSNOTREG = 0x80040154;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;
const E_NOINTERFACE = 0x80004002;
const APPMODEL_ERROR_NO_PACKAGE = 15700;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_ACCESS_DENIED = 5;
const SETTINGS_URI = "ms-settings:notifications";
const SW_SHOWNORMAL = 1;
const SHELL_SUCCESS_MINIMUM = 32;
// IInspectable has six slots. These slots come from Windows.UI.Notifications metadata.
const CREATE_NOTIFIER_WITH_ID_SLOT = 7;
const NOTIFIER_SETTING_SLOT = 8;
const RELEASE_SLOT = 2;
const MANAGER_CLASS = "Windows.UI.Notifications.ToastNotificationManager";
const MANAGER_IID = Buffer.from("3f10ac5035d29845bbef98fe4d1a3ad4", "hex");

/** Preserve unknown future Windows values without treating them as enabled. */
export function notificationSetting(value: number): NotificationSetting {
  const settings: readonly NotificationSetting[] = [
    "enabled",
    "disabledForApplication",
    "disabledForUser",
    "disabledByGroupPolicy",
    "disabledByManifest",
  ];
  return settings[value] ?? "unknown";
}

function check(result: number): void {
  if (result >= 0) {
    return;
  }
  throw new BunawayError({
    code:
      result >>> 0 === HRESULT_ACCESS_DENIED ? "PERMISSION_DENIED" : "INTERNAL",
    message: "Windows notification operation failed.",
    details: {
      hresult: result >>> 0,
    },
  });
}

/**
 * Own per-adapter DLLs. Each synchronous operation balances its own WinRT apartment and native references.
 * An STA is compatible with the opener's apartment on the same I/O worker; no callbacks or pointers survive a call.
 */
export function createNotifications(appUserModelId: string) {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(appUserModelId)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid notification app identifier.",
    });
  }
  const runtime = dlopen("combase.dll", {
    RoInitialize: {
      args: [
        "u32",
      ],
      returns: "i32",
    },
    RoUninitialize: {
      args: [],
      returns: "void",
    },
    RoGetActivationFactory: {
      args: [
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    WindowsCreateString: {
      args: [
        "ptr",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    WindowsDeleteString: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
  });
  const kernel = (() => {
    try {
      return dlopen("kernel32.dll", {
        GetCurrentPackageFullName: {
          args: [
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
      });
    } catch (error) {
      runtime.close();
      throw error;
    }
  })();
  let disposed = false;
  function active(): void {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Notification adapter is disposed.",
      });
    }
  }
  function withRuntime<T>(run: () => T): T {
    active();
    check(runtime.symbols.RoInitialize(RO_INIT_SINGLETHREADED));
    try {
      return run();
    } finally {
      runtime.symbols.RoUninitialize();
    }
  }
  return {
    /** Read the OS setting without creating shortcuts, registering activators or changing user preferences. */
    getStatus(): NotificationStatus {
      return withRuntime(() => {
        const packageSize = new Uint32Array(1);
        const packageResult = kernel.symbols.GetCurrentPackageFullName(
          ptr(packageSize),
          null,
        );
        if (
          packageResult === 0 ||
          packageResult === ERROR_INSUFFICIENT_BUFFER
        ) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message:
              "Notification status requires an unpackaged desktop app identity.",
          });
        }
        if (packageResult !== APPMODEL_ERROR_NO_PACKAGE) {
          throw new BunawayError({
            code:
              packageResult === ERROR_ACCESS_DENIED
                ? "PERMISSION_DENIED"
                : "INTERNAL",
            message: "Windows could not query the app package identity.",
          });
        }
        const strings: Pointer[] = [];
        const bindings: ReturnType<typeof CFunction>[] = [];
        const objects: Pointer[] = [];
        const method = (object: Pointer, slot: number, args: "ptr"[]) => {
          const address = read.ptr(read.ptr(object), slot * POINTER_BYTES);
          if (!address) {
            throw new BunawayError({
              code: "INTERNAL",
              message: "Windows notification interface is invalid.",
            });
          }
          const binding = CFunction({
            ptr: address as Pointer,
            args: [
              "ptr",
              ...args,
            ],
            returns: "i32",
          });
          bindings.push(binding);
          return (...values: (number | null)[]) =>
            Number(binding(object, ...values));
        };
        const string = (value: string): Pointer => {
          const text = Buffer.from(`${value}\0`, "utf16le");
          const output = new BigUint64Array(1);
          check(
            runtime.symbols.WindowsCreateString(
              ptr(text),
              value.length,
              ptr(output),
            ),
          );
          if (!output[0]) {
            throw new BunawayError({
              code: "INTERNAL",
              message: "Windows notification string allocation failed.",
            });
          }
          // Win64 pointer results occupy an eight-byte out slot and remain owned until finally.
          const address = Number(output[0]) as Pointer;
          strings.push(address);
          return address;
        };
        const output = new BigUint64Array(1);
        const ownedObject = (): Pointer => {
          if (!output[0]) {
            throw new BunawayError({
              code: "INTERNAL",
              message: "Windows notification object is missing.",
            });
          }
          const object = Number(output[0]) as Pointer;
          objects.push(object);
          output[0] = 0n;
          return object;
        };
        try {
          const result = runtime.symbols.RoGetActivationFactory(
            string(MANAGER_CLASS),
            ptr(MANAGER_IID),
            ptr(output),
          );
          if (
            [
              REGDB_E_CLASSNOTREG,
              CLASS_E_CLASSNOTAVAILABLE,
              E_NOINTERFACE,
            ].includes(result >>> 0)
          ) {
            return {
              support: "unsupported",
              appUserModelId,
              setting: null,
            };
          }
          check(result);
          const manager = ownedObject();
          check(
            method(manager, CREATE_NOTIFIER_WITH_ID_SLOT, [
              "ptr",
              "ptr",
            ])(string(appUserModelId), ptr(output)),
          );
          const notifier = ownedObject();
          const setting = new Int32Array(1);
          check(
            method(notifier, NOTIFIER_SETTING_SLOT, [
              "ptr",
            ])(ptr(setting)),
          );
          return {
            support: "supported",
            appUserModelId,
            setting: notificationSetting(setting[0] ?? -1),
          };
        } finally {
          try {
            for (const object of objects.reverse()) {
              method(object, RELEASE_SLOT, [])();
            }
          } finally {
            for (const binding of bindings) {
              binding.close();
            }
            for (const address of strings) {
              runtime.symbols.WindowsDeleteString(address);
            }
          }
        }
      });
    },
    /** Ask Windows to open its notification page. Success means request acceptance, never a settings change. */
    openSettings(): null {
      return withRuntime(() => {
        const shell = dlopen("shell32.dll", {
          ShellExecuteW: {
            args: [
              "ptr",
              "ptr",
              "ptr",
              "ptr",
              "ptr",
              "i32",
            ],
            returns: "u64",
          },
        });
        const verb = Buffer.from("open\0", "utf16le");
        const uri = Buffer.from(`${SETTINGS_URI}\0`, "utf16le");
        try {
          const result = Number(
            shell.symbols.ShellExecuteW(
              null,
              ptr(verb),
              ptr(uri),
              null,
              null,
              SW_SHOWNORMAL,
            ),
          );
          if (result <= SHELL_SUCCESS_MINIMUM) {
            throw new BunawayError({
              code:
                result === ERROR_ACCESS_DENIED
                  ? "PERMISSION_DENIED"
                  : "INTERNAL",
              message:
                "Windows could not accept the notification Settings request.",
            });
          }
          return null;
        } finally {
          shell.close();
        }
      });
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      kernel.close();
      runtime.close();
    },
  };
}
