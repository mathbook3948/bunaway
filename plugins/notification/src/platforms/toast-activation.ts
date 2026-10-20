import { type Pointer, ptr } from "bun:ffi";
import type { ToastEvent } from "#notification/contract";
import {
  checkToast,
  type createToastRuntime,
} from "#notification/platforms/toast-winrt";

// Windows SDK Windows.UI.Notifications and Windows.Foundation ABI metadata.
export const ACTIVATED_ARGS_IID = "e3bf92f3-c197-436f-8265-0625824f8dac";
export const ACTIVATED_ARGS2_IID = "ab7da512-cc61-568e-81be-304ac31038fa";
export const MAP_STRING_OBJECT_IID = "1b0d3570-0877-5ec2-8a2c-3b9539506aca";
export const PROPERTY_VALUE_IID = "4bd682dd-7554-40e9-9a9b-82654ede7e62";
/** Slot after IInspectable on each interface: get_Arguments, get_UserInput, Lookup, get_Type. */
export const FIRST_METHOD_SLOT = 6;
const MAP_HAS_KEY_SLOT = 8;
export const PROPERTY_VALUE_GET_STRING_SLOT = 19;
/** Windows.Foundation.PropertyType.String. */
const PROPERTY_TYPE_STRING = 6;

export type Runtime = ReturnType<typeof createToastRuntime>;

/** Run a COM step and always release the object it produced. */
function using<T>(
  runtime: Runtime,
  value: Pointer,
  use: (value: Pointer) => T,
): T {
  try {
    return use(value);
  } finally {
    runtime.release(value);
  }
}

function outString(
  runtime: Runtime,
  object: Pointer,
  slot: number,
  stage: string,
): string {
  const out = new BigUint64Array(1);
  checkToast(
    runtime.method(
      object,
      slot,
      [
        "ptr",
      ],
      ptr(out),
    ),
    stage,
  );
  return runtime.takeString(Number(out[0]) as Pointer);
}

/** Text typed into the reply input, or undefined when the activation carries no usable value. */
export function readReply(
  runtime: Runtime,
  input: Pointer,
  id: string,
): string | undefined {
  return using(runtime, runtime.query(input, MAP_STRING_OBJECT_IID), (map) => {
    const present = new Uint8Array(1);
    runtime.string(id, (key) =>
      checkToast(
        runtime.method(
          map,
          MAP_HAS_KEY_SLOT,
          [
            "ptr",
            "ptr",
          ],
          key,
          ptr(present),
        ),
        "ValueSet.HasKey",
      ),
    );
    if (!present[0]) {
      return undefined;
    }
    const value = runtime.string(id, (key) =>
      runtime.object(
        (out) =>
          runtime.method(
            map,
            FIRST_METHOD_SLOT,
            [
              "ptr",
              "ptr",
            ],
            key,
            out,
          ),
        "ValueSet.Lookup",
      ),
    );
    // Lookup returns an owned reference; the typed view is a second one. Both are released.
    return using(runtime, value, (boxed) =>
      using(runtime, runtime.query(boxed, PROPERTY_VALUE_IID), (property) => {
        const type = new Int32Array(1);
        checkToast(
          runtime.method(
            property,
            FIRST_METHOD_SLOT,
            [
              "ptr",
            ],
            ptr(type),
          ),
          "PropertyValue.Type",
        );
        if (type[0] !== PROPERTY_TYPE_STRING) {
          return undefined;
        }
        return outString(
          runtime,
          property,
          PROPERTY_VALUE_GET_STRING_SLOT,
          "PropertyValue.GetString",
        );
      }),
    );
  });
}

/**
 * Copy the activator arguments, and the reply text when the toast declared a reply input, out of the
 * Activated event argument. The argument is borrowed from the callback, so it is not released here.
 * Any COM failure yields no activation: the activation is dropped rather than reported as a body click.
 */
export function readActivation(
  runtime: Runtime,
  argument: Pointer,
  replyInputId: string | undefined,
):
  | Extract<
      ToastEvent,
      {
        kind: "activated";
      }
    >
  | undefined {
  if (!argument) {
    return undefined;
  }
  try {
    const activator = using(
      runtime,
      runtime.query(argument, ACTIVATED_ARGS_IID),
      (args) =>
        outString(runtime, args, FIRST_METHOD_SLOT, "Activated.Arguments"),
    );
    const reply =
      replyInputId === undefined
        ? undefined
        : using(
            runtime,
            runtime.query(argument, ACTIVATED_ARGS2_IID),
            (args2) => {
              const input = runtime.object(
                (out) =>
                  runtime.method(
                    args2,
                    FIRST_METHOD_SLOT,
                    [
                      "ptr",
                    ],
                    out,
                  ),
                "Activated.UserInput",
              );
              return using(runtime, input, (map) =>
                readReply(runtime, map, replyInputId),
              );
            },
          );
    return {
      kind: "activated",
      arguments: activator,
      reply,
    };
  } catch {
    return undefined;
  }
}
