import { expect, test } from "bun:test";
import windows, {
  parseWindowCall,
  validateWindowCall,
} from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { windowDefinitions } from "../../plugins/windows/src/contract.ts";
import { mergeCreationOptions } from "../../plugins/windows/src/platforms/creation-options.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("windows", windowDefinitions);

const registry = new NativeRegistry([
  windows._definition,
]);

test.each([
  "windows.create",
  "windows.recreate",
])(
  "%s keeps creation options restricted to presentation and uses an independent operation grant",
  async (operation) => {
    const call = {
      operation,
      payload: {},
    };
    expect(validateWindowCall(call)).toEqual(call);
    expect(await parsers.validateCall(call)).toEqual(call);
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
        payload: {},
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
        showWhenReady: "sdk" as const,
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
        window: {
          focusable: false,
        },
        visible: true,
      },
      {
        window: {
          maximized: true,
          fullscreen: true,
        },
        visible: false,
      },
      {
        window: {
          maximized: false,
          fullscreen: false,
        },
        showWhenReady: "sdk" as const,
      },
      {
        title: "Editor",
        visible: false,
      },
      {
        window: {
          backgroundColor: "#ABC",
        },
      },
      {
        window: {
          x: -1920,
          y: -100,
          useContentSize: false,
          preventOverflow: true,
        },
      },
      {
        window: {
          x: null,
          y: null,
          center: true,
        },
      },
      // A partial position is valid structurally; merging with the declaration validates pairing.
      {
        window: {
          x: 20,
        },
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
      expect(await parsers.validateCall(valid)).toEqual(valid);
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
          maxHeight: 8193,
        },
      },
      {
        visible: "false",
      },
      {
        window: {
          x: -2147483649,
          y: 0,
        },
      },
      {
        window: {
          x: 0,
          y: 2147483648,
        },
      },
      {
        window: {
          center: null,
        },
      },
      {
        window: {
          preventOverflow: 1,
        },
      },
      {
        window: {
          useContentSize: "content",
        },
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
          x: 2.5,
        },
      },
      {
        windowId: "caller-id",
      },
      {
        window: {
          focusable: null,
        },
      },
      {
        window: {
          maximized: 1,
        },
      },
      {
        window: {
          fullscreen: null,
        },
      },
      {
        window: {
          backgroundColor: "#11223344",
        },
      },
      {
        window: {
          backgroundColor: "blue",
        },
      },
      {
        window: {
          backgroundColor: null,
        },
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
      // Both the SDK adapter and serialized window helper reject extra fields.
      for (const validate of [
        async () => await parsers.validateCall(invalid),
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

test("creation options override the declared background color and normalize it", () => {
  const declared = {
    view: "main",
    title: "Main",
    home: "https://app.bunaway.local/",
    window: {
      width: 800,
      height: 600,
      backgroundColor: "#203040",
    },
  };
  expect(
    mergeCreationOptions(declared, {
      window: {
        backgroundColor: "#ABC",
      },
    }).window.backgroundColor,
  ).toBe("#aabbcc");
  expect(mergeCreationOptions(declared, {}).window.backgroundColor).toBe(
    "#203040",
  );
  expect(declared.window.backgroundColor).toBe("#203040");
});

test("a transparent window requires a custom titlebar and no background color", () => {
  const declared = {
    view: "main",
    title: "Main",
    home: "https://app.bunaway.local/",
    window: {
      width: 800,
      height: 600,
    },
  };
  const create = (window: Record<string, unknown>) =>
    mergeCreationOptions(declared, {
      window,
    });
  expect(
    create({
      transparent: true,
      titlebar: "custom",
    }).window.transparent,
  ).toBe(true);
  expect(create({}).window).not.toHaveProperty("transparent");
  expect(
    create({
      transparent: false,
    }).window.transparent,
  ).toBe(false);
  for (const window of [
    {
      transparent: true,
    },
    {
      transparent: true,
      titlebar: "system",
    },
    {
      transparent: true,
      titlebar: "custom",
      backgroundColor: "#112233",
    },
  ]) {
    expect(() => create(window)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  // A declared background color conflicts with a transparent creation option.
  expect(() =>
    mergeCreationOptions(
      {
        ...declared,
        window: {
          ...declared.window,
          titlebar: "custom",
          backgroundColor: "#203040",
        },
      },
      {
        window: {
          transparent: true,
        },
      },
    ),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});
