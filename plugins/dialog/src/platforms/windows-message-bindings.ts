import { dlopen, JSCallback, ptr } from "bun:ffi";
import { USER32, pick, wide } from "@bunaway/plugin/win32";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import {
  type MessageInput,
  type MessageResult,
  resolveCancelButton,
} from "#dialog/contract";
import type { DialogDriver } from "#dialog/platforms/windows";
import { check } from "#dialog/platforms/windows-bindings";

const TDF_USE_HICON_MAIN = 0x2;
const TDF_ALLOW_DIALOG_CANCELLATION = 0x8;
const TDF_VERIFICATION_FLAG_CHECKED = 0x100;
const TDF_CALLBACK_TIMER = 0x800;
const TDF_POSITION_RELATIVE_TO_WINDOW = 0x1000;
const TDCBF_OK_BUTTON = 0x1;
// MAKEINTRESOURCEW(-1..-3) stock icons, pointer-sized values.
const TD_WARNING_ICON = 0xffffn;
const TD_ERROR_ICON = 0xfffen;
const TD_INFORMATION_ICON = 0xfffdn;
const IDI_QUESTION = 32514n;
const IDOK = 1;
const IDCANCEL = 2;
/** Custom button IDs start above the predefined IDOK..IDCONTINUE range. */
const CUSTOM_BUTTON_ID_BASE = 1000;
const TDN_CREATED = 0;
// TDF_CALLBACK_TIMER makes TaskDialog send TDN_TIMER about every 200 ms; that is the cancellation poll.
const TDN_TIMER = 4;
const TDM_CLICK_BUTTON = 0x0466;
const S_OK = 0;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;

/** TASKDIALOGCONFIG and TASKDIALOG_BUTTON use 1-byte packing (pshpack1) in commctrl.h. */
export const TASKDIALOGCONFIG_SIZE = 160;
export const TASKDIALOG_BUTTON_SIZE = 12;
const CONFIG_OFFSET = {
  cbSize: 0,
  hwndParent: 4,
  dwFlags: 20,
  dwCommonButtons: 24,
  pszWindowTitle: 28,
  mainIcon: 36,
  pszMainInstruction: 44,
  pszContent: 52,
  cButtons: 60,
  pButtons: 64,
  nDefaultButton: 72,
  pszVerificationText: 92,
  pfCallback: 140,
} as const;

/** Native identifier of the button at `index` when custom buttons are used. */
export function customButtonId(index: number): number {
  return CUSTOM_BUTTON_ID_BASE + index;
}

/**
 * Map the TaskDialog result ID to the public button index.
 *
 * `buttonCount` is the number of custom buttons, or undefined when the common OK button is used.
 * IDCANCEL (Escape, title-bar close, Alt+F4) is only possible when a cancel button resolves, so any
 * other ID is a native contract violation.
 */
export function messageButtonIndex(
  nativeId: number,
  buttonCount: number | undefined,
  cancelButton: number | undefined,
): number {
  const cancelIndex = resolveCancelButton(buttonCount ?? 1, cancelButton);
  if (nativeId === IDCANCEL && cancelIndex !== undefined) {
    return cancelIndex;
  }
  if (buttonCount === undefined && nativeId === IDOK) {
    return 0;
  }
  const index = nativeId - CUSTOM_BUTTON_ID_BASE;
  if (buttonCount !== undefined && index >= 0 && index < buttonCount) {
    return index;
  }
  throw new BunawayError({
    code: "INTERNAL",
    message: "Windows message dialog returned an unexpected button.",
    details: {
      buttonId: nativeId,
    },
  });
}

/** Native values that depend on live OS state and so cannot be derived from the request. */
export type TaskDialogNativeValues = {
  /** Owner HWND, or 0n for an unowned dialog. */
  owner: bigint;
  /** Address of the TaskDialog callback procedure. */
  callback: bigint;
  /** Shared system question icon handle, used only for the `question` type. */
  questionIcon: bigint;
};

/** Encoded TASKDIALOGCONFIG. Every buffer in `keepAlive` must stay referenced until the call returns. */
export type EncodedTaskDialog = {
  config: Buffer;
  keepAlive: Buffer[];
};

/**
 * Escape `&` so TaskDialog shows it literally. Button and verification (checkbox) labels treat a
 * single `&` as an access-key mnemonic prefix; the main instruction, content and title do not.
 */
export function escapeMnemonic(label: string): string {
  return label.replaceAll("&", "&&");
}

/**
 * Encode the request into the packed x64 TASKDIALOGCONFIG. Pure apart from reading buffer addresses
 * through `addressOf`, so tests can verify the layout without calling native code.
 */
export function encodeTaskDialogConfig(
  input: MessageInput,
  native: TaskDialogNativeValues,
  addressOf: (buffer: Buffer) => bigint = (buffer) => BigInt(ptr(buffer)),
): EncodedTaskDialog {
  const keepAlive: Buffer[] = [];
  const text = (value: string | undefined): bigint => {
    if (value === undefined) {
      return 0n;
    }
    const buffer = wide(value);
    keepAlive.push(buffer);
    return addressOf(buffer);
  };
  const config = Buffer.alloc(TASKDIALOGCONFIG_SIZE);
  const buttonCount = input.buttons?.length;
  const cancelIndex = resolveCancelButton(buttonCount ?? 1, input.cancelButton);
  let flags = TDF_CALLBACK_TIMER;
  if (cancelIndex !== undefined) {
    flags |= TDF_ALLOW_DIALOG_CANCELLATION;
  }
  if (input.checkbox?.checked) {
    flags |= TDF_VERIFICATION_FLAG_CHECKED;
  }
  if (native.owner !== 0n) {
    flags |= TDF_POSITION_RELATIVE_TO_WINDOW;
  }
  let mainIcon = 0n;
  switch (input.type) {
    case "info":
      mainIcon = TD_INFORMATION_ICON;
      break;
    case "warning":
      mainIcon = TD_WARNING_ICON;
      break;
    case "error":
      mainIcon = TD_ERROR_ICON;
      break;
    case "question":
      mainIcon = native.questionIcon;
      flags |= TDF_USE_HICON_MAIN;
      break;
    default:
      break;
  }
  config.writeUInt32LE(TASKDIALOGCONFIG_SIZE, CONFIG_OFFSET.cbSize);
  config.writeBigUInt64LE(native.owner, CONFIG_OFFSET.hwndParent);
  config.writeUInt32LE(flags, CONFIG_OFFSET.dwFlags);
  config.writeBigUInt64LE(text(input.title), CONFIG_OFFSET.pszWindowTitle);
  config.writeBigUInt64LE(mainIcon, CONFIG_OFFSET.mainIcon);
  config.writeBigUInt64LE(
    text(input.message),
    CONFIG_OFFSET.pszMainInstruction,
  );
  config.writeBigUInt64LE(text(input.detail), CONFIG_OFFSET.pszContent);
  if (input.buttons) {
    const buttons = Buffer.alloc(input.buttons.length * TASKDIALOG_BUTTON_SIZE);
    input.buttons.forEach((label, index) => {
      const offset = index * TASKDIALOG_BUTTON_SIZE;
      buttons.writeInt32LE(customButtonId(index), offset);
      buttons.writeBigUInt64LE(text(escapeMnemonic(label)), offset + 4);
    });
    keepAlive.push(buttons);
    config.writeUInt32LE(input.buttons.length, CONFIG_OFFSET.cButtons);
    config.writeBigUInt64LE(addressOf(buttons), CONFIG_OFFSET.pButtons);
    config.writeInt32LE(
      customButtonId(input.defaultButton ?? 0),
      CONFIG_OFFSET.nDefaultButton,
    );
  } else {
    config.writeUInt32LE(TDCBF_OK_BUTTON, CONFIG_OFFSET.dwCommonButtons);
    config.writeInt32LE(IDOK, CONFIG_OFFSET.nDefaultButton);
  }
  config.writeBigUInt64LE(
    text(
      input.checkbox === undefined
        ? undefined
        : escapeMnemonic(input.checkbox.label),
    ),
    CONFIG_OFFSET.pszVerificationText,
  );
  config.writeBigUInt64LE(native.callback, CONFIG_OFFSET.pfCallback);
  return {
    config,
    keepAlive,
  };
}

/** Minimal manifest that makes LoadLibrary and window creation bind Common-Controls v6. */
const COMMON_CONTROLS_MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
`;
const ACTCTXW_SIZE = 56; // x64 with natural alignment.
const ACTCTXW_SOURCE_OFFSET = 8;

/**
 * Own one message dialog and its Common-Controls v6 activation context. Importing this module
 * allocates no OS resources.
 *
 * TaskDialogIndirect exists only in comctl32 v6, but bun.exe carries no v6 manifest. The driver
 * therefore creates an activation context from a private temporary manifest and activates it on the
 * calling thread around both loading comctl32 and the modal call.
 */
export function createMessageDialog(
  input: MessageInput,
): DialogDriver<MessageResult> {
  const failure = (stage: string, hresult?: number) =>
    new BunawayError({
      code: "INTERNAL",
      message: "Windows message dialog failed.",
      details:
        hresult === undefined
          ? {
              stage,
            }
          : {
              stage,
              hresult: hresult >>> 0,
            },
    });
  const kernel = dlopen("kernel32.dll", {
    CreateActCtxW: {
      args: [
        "ptr",
      ],
      returns: "u64",
    },
    ActivateActCtx: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    DeactivateActCtx: {
      args: [
        "u32",
        "u64",
      ],
      returns: "i32",
    },
    ReleaseActCtx: {
      args: [
        "u64",
      ],
      returns: "void",
    },
  });
  const libraries: {
    close(): void;
  }[] = [
    kernel,
  ];
  let context = INVALID_HANDLE_VALUE;
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      if (context !== INVALID_HANDLE_VALUE) {
        kernel.symbols.ReleaseActCtx(context);
      }
    } finally {
      for (const library of libraries.reverse()) {
        library.close();
      }
    }
  };
  /** Run `action` with the Common-Controls v6 context active; deactivate on this thread in LIFO order. */
  const activated = <T>(action: () => T): T => {
    const cookie = new BigUint64Array(1);
    if (!kernel.symbols.ActivateActCtx(context, ptr(cookie))) {
      throw failure("ActivateActCtx");
    }
    try {
      return action();
    } finally {
      kernel.symbols.DeactivateActCtx(0, cookie[0] ?? 0n);
    }
  };
  try {
    const user = dlopen("user32.dll", {
      ...pick(USER32, "SendMessageW", "LoadIconW"),
    });
    libraries.push(user);
    // CreateActCtxW reads the manifest during the call, so the private directory is removed at once.
    const directory = mkdtempSync(join(tmpdir(), "bunaway-dialog-"));
    try {
      const manifest = join(directory, "common-controls.manifest");
      writeFileSync(manifest, COMMON_CONTROLS_MANIFEST);
      const path = wide(manifest);
      const actctx = Buffer.alloc(ACTCTXW_SIZE);
      actctx.writeUInt32LE(ACTCTXW_SIZE, 0);
      actctx.writeBigUInt64LE(BigInt(ptr(path)), ACTCTXW_SOURCE_OFFSET);
      context = BigInt(kernel.symbols.CreateActCtxW(ptr(actctx)));
      // The manifest path is referenced only by address in `actctx`, so it must outlive CreateActCtxW.
      void path.length;
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true,
      });
    }
    if (context === INVALID_HANDLE_VALUE) {
      throw failure("CreateActCtxW");
    }
    const comctl = activated(() =>
      dlopen("comctl32.dll", {
        TaskDialogIndirect: {
          args: [
            "ptr",
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
      }),
    );
    libraries.push(comctl);
    const buttonCount = input.buttons?.length;
    // Any existing button ID closes the dialog through TDM_CLICK_BUTTON.
    const closeButtonId = buttonCount === undefined ? IDOK : customButtonId(0);
    return {
      show(owner, poll) {
        if (disposed) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Dialog is disposed.",
          });
        }
        let callbackFailure: unknown;
        let hwnd = 0n;
        let handling = false;
        const callback = new JSCallback(
          (window: bigint, message: number, _wParam: bigint) => {
            try {
              if (message === TDN_CREATED) {
                hwnd = BigInt(window);
                return S_OK;
              }
              // TDN_BUTTON_CLICKED must pass through so a synthetic click can close the dialog.
              if (message !== TDN_TIMER || handling) {
                return S_OK;
              }
              handling = true;
              try {
                let interrupted: boolean;
                try {
                  interrupted = poll();
                } catch (error) {
                  callbackFailure ??= error;
                  interrupted = true;
                }
                if (interrupted && hwnd) {
                  // Synchronous on this STA: no queued message may outlive the dialog.
                  user.symbols.SendMessageW(
                    hwnd,
                    TDM_CLICK_BUTTON,
                    BigInt(closeButtonId),
                    0n,
                  );
                }
              } finally {
                handling = false;
              }
            } catch (error) {
              // Never propagate exceptions through a native callback stack.
              callbackFailure ??= error;
            }
            return S_OK;
          },
          {
            args: [
              "u64",
              "u32",
              "u64",
              "i64",
              "i64",
            ],
            returns: "i32",
          },
        );
        try {
          const callbackAddress = callback.ptr;
          if (!callbackAddress) {
            throw failure("JSCallback");
          }
          const icon =
            input.type === "question"
              ? BigInt(user.symbols.LoadIconW(0n, IDI_QUESTION))
              : 0n;
          const encoded = encodeTaskDialogConfig(input, {
            owner,
            callback: BigInt(callbackAddress),
            questionIcon: icon,
          });
          const pressed = new Int32Array(1);
          const verified = new Int32Array(1);
          const result = activated(() =>
            comctl.symbols.TaskDialogIndirect(
              ptr(encoded.config),
              ptr(pressed),
              null,
              ptr(verified),
            ),
          );
          // Strings and the button array must outlive the native call.
          void encoded.keepAlive.length;
          if (callbackFailure) {
            throw callbackFailure;
          }
          check(result, "TaskDialogIndirect", "Windows message dialog failed.");
          return {
            button: messageButtonIndex(
              pressed[0] ?? 0,
              buttonCount,
              input.cancelButton,
            ),
            checkboxChecked: !!input.checkbox && verified[0] !== 0,
          };
        } finally {
          // The dialog is synchronous and destroyed, so no further callbacks can arrive.
          callback.close();
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
