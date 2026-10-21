import {
  dlopen,
  JSCallback,
  type Pointer,
  ptr,
  read,
  toArrayBuffer,
} from "bun:ffi";
import { OLE32, pick } from "@bunaway/plugin/win32";
import { MAX_REPLY_LENGTH } from "#notification/contract";
import { MAX_ACTIVATION_ARGUMENT_LENGTH } from "#notification/platforms/toast-activation-args";
import { checkToast, guid } from "#notification/platforms/toast-winrt";

const POINTER_BYTES = 8;
const GUID_BYTES = 16;
const S_OK = 0;
const E_NOINTERFACE = -2147467262;
const E_POINTER = -2147467261;
const E_INVALIDARG = -2147024809;
const CLASS_E_NOAGGREGATION = -2147221232;
const CLSCTX_LOCAL_SERVER = 0x4;
const REGCLS_MULTIPLEUSE = 1;
/** Windows limits an AppUserModelID to 128 characters. */
const MAX_APP_USER_MODEL_ID_LENGTH = 128;
/** A toast declares at most one input, the reply box, so more entries did not come from this plugin. */
const MAX_USER_INPUTS = 1;
/** The input key the toast XML gives the reply box. */
const REPLY_INPUT_KEY = "reply";
const IID_UNKNOWN = guid("00000000-0000-0000-c000-000000000046");
const IID_CLASS_FACTORY = guid("00000001-0000-0000-c000-000000000046");
// INotificationActivationCallback from notificationactivationcallback.h.
const IID_ACTIVATION_CALLBACK = guid("53e31837-6600-4a81-9395-75cffe746f94");

/** One click reported by Windows, copied out of the call before it returned. */
export type ActivatorCall = {
  appUserModelId: string;
  arguments: string;
  /** Text of the reply input, or null when the call carried no reply input. */
  reply: string | null;
};

export type ToastActivatorServer = {
  /** Revoke the class object. Safe to call twice. */
  dispose(): void;
};

/**
 * Copy a NUL-terminated UTF-16 string from memory owned by the caller. Returns null when no
 * terminator appears within `maxChars`, so oversized text is rejected without being copied.
 */
function readBoundedWide(address: Pointer, maxChars: number): string | null {
  let length = 0;
  while (length <= maxChars && read.u16(address, length * 2)) {
    length++;
  }
  if (length > maxChars) {
    return null;
  }
  return Buffer.from(toArrayBuffer(address, 0, length * 2)).toString("utf16le");
}

/** Reply text of the NOTIFICATION_USER_INPUT_DATA entry (two LPCWSTR: key, value), or null when it is another input. */
function readReplyInput(entry: Pointer): string | null | undefined {
  const key = read.ptr(entry, 0) as Pointer;
  const value = read.ptr(entry, POINTER_BYTES) as Pointer;
  // Only the reply box is read; the toast declares no other input.
  if (
    !key ||
    readBoundedWide(key, REPLY_INPUT_KEY.length) !== REPLY_INPUT_KEY
  ) {
    return null;
  }
  // A missing value reads as nothing typed; an oversized one rejects the whole call.
  return value ? (readBoundedWide(value, MAX_REPLY_LENGTH) ?? undefined) : "";
}

/**
 * Validate and copy the Activate parameters. Windows hands them to any process that can reach the
 * activator, so every pointer, length and count is checked before use. Returns undefined for a call
 * this plugin cannot have produced.
 */
function readActivatorCall(
  appUserModelId: Pointer,
  invokedArguments: Pointer,
  data: Pointer,
  count: number,
): ActivatorCall | undefined {
  if (!appUserModelId || !invokedArguments || count > MAX_USER_INPUTS) {
    return undefined;
  }
  const id = readBoundedWide(appUserModelId, MAX_APP_USER_MODEL_ID_LENGTH);
  const text = readBoundedWide(
    invokedArguments,
    MAX_ACTIVATION_ARGUMENT_LENGTH,
  );
  if (id === null || text === null || (count === 1 && !data)) {
    return undefined;
  }
  const reply = count === 1 ? readReplyInput(data) : null;
  if (reply === undefined) {
    return undefined;
  }
  return {
    appUserModelId: id,
    arguments: text,
    reply,
  };
}

/** One native COM object whose interface methods are JS callbacks. */
type ComObject = {
  pointer: Pointer;
  /** References held by COM callers, plus the owner's own. */
  references(): number;
  addReference(): void;
  /** Release the JS callbacks. Only valid once no native caller can reach the object. */
  close(): void;
  /** Memory a native caller may still read while it holds a reference. */
  readonly retained: unknown[];
};

/**
 * Create a COM object with IUnknown plus `methods` (slot 3 onward). It answers QueryInterface only
 * for IUnknown and `interfaceIds`, so IMarshal and IAgileObject are refused: the object stays bound to
 * the apartment that created it and Windows marshals calls to that apartment's message pump.
 */
function createComObject(
  interfaceIds: Buffer[],
  methods: JSCallback[],
): ComObject {
  const object = new BigUint64Array(1);
  let references = 1;
  const query = new JSCallback(
    (_self: Pointer, requested: Pointer, output: Pointer) => {
      if (!output) {
        return E_POINTER;
      }
      const out = new DataView(toArrayBuffer(output, 0, POINTER_BYTES));
      out.setBigUint64(0, 0n, true);
      if (!requested) {
        return E_POINTER;
      }
      const id = Buffer.from(toArrayBuffer(requested, 0, GUID_BYTES));
      if (
        !id.equals(IID_UNKNOWN) &&
        !interfaceIds.some((known) => known.equals(id))
      ) {
        return E_NOINTERFACE;
      }
      out.setBigUint64(0, BigInt(ptr(object)), true);
      references++;
      return S_OK;
    },
    {
      args: [
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  );
  const retain = new JSCallback(() => ++references, {
    args: [
      "ptr",
    ],
    returns: "u32",
  });
  const release = new JSCallback(() => --references, {
    args: [
      "ptr",
    ],
    returns: "u32",
  });
  const callbacks = [
    query,
    retain,
    release,
    ...methods,
  ];
  const vtable = new BigUint64Array(
    callbacks.map((callback) => BigInt(callback.ptr ?? 0)),
  );
  object[0] = BigInt(ptr(vtable));
  return {
    pointer: ptr(object),
    references: () => references,
    addReference: () => {
      references++;
    },
    close() {
      for (const callback of callbacks) {
        callback.close();
      }
    },
    retained: [
      object,
      vtable,
      callbacks,
    ],
  };
}

// Objects that native callers may still reference after the class object was revoked. Their callbacks
// stay valid until the process exits instead of risking a call into freed code.
const outlivingObjects: unknown[] = [];

/** IClassFactory::CreateInstance for the single stateless callback object. */
function createInstanceCallback(callbackObject: ComObject): JSCallback {
  return new JSCallback(
    (_self: Pointer, outer: Pointer, requested: Pointer, output: Pointer) => {
      if (!output) {
        return E_POINTER;
      }
      const out = new DataView(toArrayBuffer(output, 0, POINTER_BYTES));
      out.setBigUint64(0, 0n, true);
      if (outer) {
        return CLASS_E_NOAGGREGATION;
      }
      if (!requested) {
        return E_POINTER;
      }
      const id = Buffer.from(toArrayBuffer(requested, 0, GUID_BYTES));
      if (!id.equals(IID_UNKNOWN) && !id.equals(IID_ACTIVATION_CALLBACK)) {
        return E_NOINTERFACE;
      }
      // One stateless object serves every caller; each caller owns one reference.
      callbackObject.addReference();
      out.setBigUint64(0, BigInt(callbackObject.pointer), true);
      return S_OK;
    },
    {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  );
}

/**
 * Register a COM class object for the toast activator CLSID in the calling STA, so Windows delivers
 * a click on one of this app's notifications to `receive` while the app runs. When the app is not
 * running, Windows starts the executable that the CLSID's `LocalServer32` key names and waits for this
 * registration, which makes the click reach the new process.
 *
 * Call from the thread that pumps messages for the STA; incoming calls are dispatched through that pump.
 * `receive` runs on a later turn of the event loop, never inside the native call.
 */
export function registerToastActivator(
  clsid: string,
  receive: (call: ActivatorCall) => void,
): ToastActivatorServer {
  const activate = new JSCallback(
    (
      _self: Pointer,
      appUserModelId: Pointer,
      invokedArguments: Pointer,
      data: Pointer,
      count: number,
    ) => {
      try {
        const call = readActivatorCall(
          appUserModelId,
          invokedArguments,
          data,
          count,
        );
        if (!call) {
          return E_INVALIDARG;
        }
        // The values are copied, so the callback can leave the native stack before publishing.
        queueMicrotask(() => receive(call));
        return S_OK;
      } catch {
        // Never unwind a JS exception through COM; Windows only needs to know the call failed.
        return E_INVALIDARG;
      }
    },
    {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  );
  const callbackObject = createComObject(
    [
      IID_ACTIVATION_CALLBACK,
    ],
    [
      activate,
    ],
  );
  const lockServer = new JSCallback(() => S_OK, {
    args: [
      "ptr",
      "i32",
    ],
    returns: "i32",
  });
  const factoryObject = createComObject(
    [
      IID_CLASS_FACTORY,
    ],
    [
      createInstanceCallback(callbackObject),
      lockServer,
    ],
  );
  const closeAll = () => {
    factoryObject.close();
    callbackObject.close();
  };
  const ole = dlopen("ole32.dll", {
    ...pick(OLE32, "CoRegisterClassObject", "CoRevokeClassObject"),
  });
  const cookie = new Uint32Array(1);
  try {
    checkToast(
      ole.symbols.CoRegisterClassObject(
        ptr(guid(clsid)),
        factoryObject.pointer,
        CLSCTX_LOCAL_SERVER,
        REGCLS_MULTIPLEUSE,
        ptr(cookie),
      ),
      "CoRegisterClassObject",
    );
  } catch (error) {
    // Nothing was published to native code, so the callbacks can be released right away.
    ole.close();
    closeAll();
    throw error;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        checkToast(
          ole.symbols.CoRevokeClassObject(cookie[0] ?? 0),
          "CoRevokeClassObject",
        );
      } finally {
        ole.close();
        // COM drops its factory reference on revoke. Callers that still hold the activation object keep
        // it alive until they disconnect, so release the callbacks only when nobody does.
        if (
          factoryObject.references() === 1 &&
          callbackObject.references() === 1
        ) {
          closeAll();
        } else {
          outlivingObjects.push(
            factoryObject.retained,
            callbackObject.retained,
          );
        }
      }
    },
  };
}
