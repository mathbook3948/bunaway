import { expect, test } from "bun:test";
import {
  parseWindowCall,
  validateWindowCall,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";

const registry = new NativeRegistry([
  windowsPlugin,
]);

test.each([
  "windows.create",
  "windows.recreate",
])(
  "%s keeps creation options restricted to presentation and uses an independent operation grant",
  (operation) => {
    const call = {
      operation,
      payload: {
        view: "editor",
      },
    };
    expect(validateWindowCall(call)).toEqual(call);
    expect(registry.validateCall(call)).toEqual(call);
    expect(registry.operation(operation).name).toBe(operation);
    const permissions = {
      permissions: [
        operation,
      ],
    };
    expect(registry.allowed(permissions, call)).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        call,
      ),
    ).toBe(false);
    expect(
      registry.allowed(permissions, {
        ...call,
        payload: {
          view: "main",
        },
      }),
    ).toBe(true);

    const extras: Record<string, JsonValue>[] = [
      {
        title: "New title",
      },
      {
        window: {
          width: 800,
          height: 600,
        },
      },
      {
        visible: false,
      },
      {
        showWhenReady: "sdk",
      },
      {
        home: "https://app.bunaway.local/other.html",
      },
      {
        windowId: "caller-chosen-id",
      },
      {
        viewId: "another-policy",
      },
      {
        profile: "shared",
      },
      {
        parent: "window-parent",
        modal: true,
      },
    ];
    for (const options of [
      {},
      {
        title: "Editor",
        visible: false,
      },
      {
        window: {
          minWidth: null,
          height: 900,
        },
        showWhenReady: null,
      },
    ]) {
      const valid = {
        ...call,
        payload: {
          ...call.payload,
          options,
        },
      };
      expect(registry.validateCall(valid)).toEqual(valid);
      expect(parseWindowCall(JSON.stringify(valid))).toEqual(valid);
    }
    for (const options of [
      null,
      {
        title: "",
      },
      {
        title: "bad\0title",
      },
      {
        window: {
          width: 199,
        },
      },
      {
        window: {
          maxHeight: 4097,
        },
      },
      {
        visible: "false",
      },
      {
        showWhenReady: "app",
      },
      {
        home: "https://outside.invalid",
      },
      {
        profile: "shared",
      },
      {
        window: {
          x: 20,
        },
      },
      {
        windowId: "caller-id",
      },
    ]) {
      extras.push({
        options,
      });
    }
    for (const extra of extras) {
      const invalid = {
        ...call,
        payload: {
          ...call.payload,
          ...extra,
        },
      };
      // Both the public native registry and serialized host boundary reject extra fields.
      for (const validate of [
        () => registry.validateCall(invalid),
        () => parseWindowCall(JSON.stringify(invalid)),
      ]) {
        expect(validate).toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      }
    }
  },
);
