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

/** A native window whose only pending close request is `pendingRequestId`, like the UI owner's. */
function fixture(options: { respondClose?: boolean } = {}) {
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
      "main",
    ].map((view) => ({
      view,
      title: view,
      home: "https://app.bunaway.local",
      window: {
        width: 400,
        height: 300,
      },
    })),
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
    view: "main",
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
        windowId: "window-1",
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
      view: "main",
      requestId: 1,
    },
    {
      view: "main",
      allow: true,
    },
    {
      ...accepted,
      extra: true,
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
    view: "main",
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

test("respondClose is unsupported where the native window has no close requests", async () => {
  const f = fixture({
    respondClose: false,
  });
  await expect(
    f.invoke({
      view: "main",
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
