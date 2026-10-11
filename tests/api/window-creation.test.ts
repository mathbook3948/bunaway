import { expect, test } from "bun:test";
import {
  parseWindowCall,
  validateWindowCall,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { matches } from "#plugins/windows/src/scope";

const registry = new NativeRegistry([
  windowsPlugin,
]);

test.each([
  "windows.create",
  "windows.recreate",
])(
  "%s accepts only a declared-view selector contract and keeps control scoped to its target",
  (operation) => {
    const call = {
      operation,
      payload: {
        view: "editor",
      },
    };
    expect(validateWindowCall(call)).toEqual(call);
    expect(registry.validateCall(call)).toEqual(call);
    expect(registry.operation(operation).permission).toBe("windows:control");
    const permissions = {
      permissions: [
        {
          identifier: "windows:control",
          allow: [
            {
              view: "editor",
            },
          ],
        },
      ],
    };
    expect(registry.allowed(permissions, call, matches)).toBe(true);
    expect(
      registry.allowed(
        permissions,
        {
          ...call,
          payload: {
            view: "main",
          },
        },
        matches,
      ),
    ).toBe(false);

    const extras: Record<string, JsonValue>[] = [
      {
        options: {},
      },
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
