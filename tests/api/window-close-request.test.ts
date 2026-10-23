import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
  windowEvents,
} from "@bunaway/plugin-windows";
import {
  BunawayError,
  type JsonValue,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const allGrants: Policy["backend"] = {
  permissions: windowPermissions(),
};

const mainIdentity = {
  windowId: "window-main",
  viewId: "main",
};
const otherIdentity = {
  windowId: "window-other",
  viewId: "other",
};

/**
 * A native window whose only pending close request is `pendingRequestId`, like the UI owner's.
 * `caller` is the authenticated window behind the host request (`lookup.byRequest`); `null`
 * means the request has no known document, and `"unavailable"` omits `byRequest` entirely.
 */
function fixture(
  options: {
    respondClose?: boolean;
    caller?: typeof mainIdentity | typeof otherIdentity | null | "unavailable";
  } = {},
) {
  const caller = options.caller === undefined ? mainIdentity : options.caller;
  const answers: unknown[] = [];
  const pendingRequestId = 7;
  const unused = (): never => {
    throw new Error("Unexpected native call");
  };
  const native = {
    respondClose:
      options.respondClose === false
        ? undefined
        : (requestId: number, allow: boolean) => {
            if (requestId !== pendingRequestId) {
              throw new BunawayError({
                code: "INVALID_ARGUMENT",
                message: "No pending close request.",
              });
            }
            answers.push({
              requestId,
              allow,
            });
          },
  } as unknown as NativeWindow;
  const services: NativeWindowServices = {
    specs: [
      {
        view: "main",
        title: "main",
        home: "https://app.bunaway.local",
        window: {
          width: 400,
          height: 300,
        },
      },
    ],
    lookup: {
      byId: unused,
      byView: unused,
      ...(caller === "unavailable"
        ? {}
        : {
            byRequest: () => caller,
          }),
      focused: unused,
      lastActive: unused,
    },
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    window: () => native,
    create: unused,
    close: unused,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
  };
  const execute = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  }).executeUI;
  if (!execute) {
    throw new Error("Missing UI executor");
  }
  return {
    answers,
    pendingRequestId,
    invoke: (input: JsonValue, source = "backend", permissions = allGrants) =>
      Promise.resolve().then(() =>
        execute("windows.respondClose", input, source, {
          requestId: "request",
          permissions,
        }),
      ),
  };
}

test("respondClose input requires a positive safe integer requestId and a boolean decision", () => {
  const accepted = {
    requestId: 1,
    allow: true,
  };
  expect(
    validateWindowCall({
      operation: "windows.respondClose",
      payload: accepted,
    }),
  ).toEqual({
    operation: "windows.respondClose",
    payload: accepted,
  });
  expect(
    validateWindowCall({
      operation: "windows.respondClose",
      payload: {
        ...accepted,
        requestId: Number.MAX_SAFE_INTEGER,
      },
    }).operation,
  ).toBe("windows.respondClose");
  for (const invalid of [
    {
      ...accepted,
      requestId: 0,
    },
    {
      ...accepted,
      requestId: -1,
    },
    {
      ...accepted,
      requestId: 1.5,
    },
    {
      ...accepted,
      requestId: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      ...accepted,
      requestId: "1",
    },
    {
      ...accepted,
      allow: "yes",
    },
    {
      requestId: 1,
    },
    {
      allow: true,
    },
    {
      ...accepted,
      extra: true,
    },
    {
      ...accepted,
      windowId: "window-1",
    },
  ] satisfies JsonValue[]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.respondClose",
        payload: invalid,
      }),
    ).toThrow();
  }
  expect(validateWindowOutput("windows.respondClose", null)).toBeNull();
  expect(() => validateWindowOutput("windows.respondClose", true)).toThrow();
});

test("respondClose needs its own operation grant and reports a request that is not pending", async () => {
  const f = fixture();
  const input = {
    requestId: f.pendingRequestId,
    allow: false,
  };
  await expect(
    f.invoke(input, "backend", {
      permissions: [
        "windows.close",
      ],
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(f.answers).toEqual([]);
  expect(await f.invoke(input)).toBeNull();
  expect(
    await f.invoke(
      {
        ...input,
        allow: true,
      },
      "view:main",
      {
        permissions: [
          "windows.respondClose",
        ],
      },
    ),
  ).toBeNull();
  expect(f.answers).toEqual([
    {
      requestId: 7,
      allow: false,
    },
    {
      requestId: 7,
      allow: true,
    },
  ]);
  await expect(
    f.invoke({
      ...input,
      requestId: 8,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "No pending close request.",
  });
});

test("respondClose from the asked window's document is allowed", async () => {
  const f = fixture();
  const input = {
    requestId: f.pendingRequestId,
    allow: true,
  };
  expect(await f.invoke(input, "view:main")).toBeNull();
  expect(f.answers).toHaveLength(1);
});

test("respondClose from another window's document is denied before reaching the native window", async () => {
  const denied = {
    code: "PERMISSION_DENIED",
  };
  const input = {
    requestId: 7,
    allow: true,
  };
  // Another view's document guesses the requestId of the main window.
  const other = fixture({
    caller: otherIdentity,
  });
  await expect(other.invoke(input, "view:other")).rejects.toMatchObject(denied);
  // The authenticated identity must match the claimed call source.
  const mismatched = fixture({
    caller: otherIdentity,
  });
  await expect(mismatched.invoke(input, "view:main")).rejects.toMatchObject(
    denied,
  );
  // Without a known document behind the request, or without request lookup, the call fails closed.
  const unknown = fixture({
    caller: null,
  });
  await expect(unknown.invoke(input, "view:main")).rejects.toMatchObject(
    denied,
  );
  const unavailable = fixture({
    caller: "unavailable",
  });
  await expect(unavailable.invoke(input, "view:main")).rejects.toMatchObject(
    denied,
  );
  for (const f of [
    other,
    mismatched,
    unknown,
    unavailable,
  ]) {
    expect(f.answers).toEqual([]);
  }
});

test("respondClose from the backend does not need request lookup", async () => {
  const f = fixture({
    caller: "unavailable",
  });
  expect(
    await f.invoke({
      requestId: f.pendingRequestId,
      allow: false,
    }),
  ).toBeNull();
  expect(f.answers).toHaveLength(1);
});

test("respondClose is unsupported where the native window has no close requests", async () => {
  const f = fixture({
    respondClose: false,
  });
  await expect(
    f.invoke({
      requestId: 1,
      allow: true,
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("the closeRequested event carries one window identity and a positive request id", () => {
  const schema = windowEvents["windows.closeRequested"];
  const event = {
    windowId: "window-1",
    viewId: "main",
    requestId: 1,
  };
  expect(validateValue(schema, event)).toEqual(event);
  for (const invalid of [
    {
      ...event,
      requestId: 0,
    },
    {
      ...event,
      requestId: 1.5,
    },
    {
      windowId: "window-1",
      viewId: "main",
    },
    {
      ...event,
      extra: 1,
    },
  ]) {
    expect(() => validateValue(schema, invalid)).toThrow();
  }
});

test("the windows plugin declares respondClose among its native operations", () => {
  const names = windows._definition.native.operations.map(({ name }) => name);
  expect(names).toContain("windows.respondClose");
});

test("both desktop platforms register respondClose, so a macOS policy may reference windows.respondClose", () => {
  // macOS emits windows.closeRequested through the same close order, so its policy needs the answer operation.
  expect(windows._definition.nativePlatforms.windows?.operations).toContain(
    "respondClose",
  );
  expect(windows._definition.nativePlatforms.macos?.operations).toContain(
    "respondClose",
  );
});
