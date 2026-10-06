import { expect, test } from "bun:test";
import {
  command,
  createCore,
  defineApp,
  defineModule,
  type AppDefinition,
  type CommandsOf,
  type EventsOf,
  type ModuleDefinition,
  type PluginDefinition,
} from "../../packages/backend-sdk/src/index.ts";
import { createClient, type Client } from "../../packages/client-sdk/src/index.ts";
import type { CoreServices } from "../../packages/core/src/index.ts";
import {
  type ClientMessage,
  type HostContext,
  type TransportEvent,
  parseMessage,
} from "../../packages/protocol/src/index.ts";

const textSchema = { type: "string", maxLength: 32 } as const;
const contract = { input: textSchema, output: { const: null } } as const;
const memo = defineModule("memo")
  .command("save", contract, async (text, context) => {
    context.state.set("memo", text);
    await context.events.emit("memo.saved", text, { kind: "broadcast" });
    return null;
  })
  .command("read", { input: { const: null }, output: textSchema }, (_input, context) =>
    String(context.state.get("memo")),
  )
  .event("saved", textSchema);
const settings = defineModule("settings").command(
  "save",
  { input: { type: "integer" }, output: { type: "integer" } },
  (input) => input,
);
const app = defineApp({
  modules: [memo, settings],
  state: { memo: "initial" },
}) satisfies AppDefinition;

test("module commands retain validation, policy and events through Core and Client", async () => {
  let deliver: (event: TransportEvent) => void = () => {};
  const services: CoreServices = {
    policy: {
      version: 1,
      views: [
        {
          id: "main",
          origins: ["https://app.bunaway.local"],
          commands: ["memo.save", "memo.read"],
          events: ["memo.saved"],
          host: { log: false, storage: [] },
        },
      ],
      backend: { log: false, storage: [] },
    },
    hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "modules" },
    platform: "windows",
    backendContext: "module-backend" as HostContext,
    runtime: {
      createCancellation: () => new AbortController(),
      now: () => performance.now(),
      schedule(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    async send(_context, message) {
      deliver({ kind: "message", text: JSON.stringify(message) });
    },
    async callHost() {
      throw new Error("No Host calls expected.");
    },
  };
  const core = await createCore(app, services);
  const session = core.openSession("module-view" as HostContext, "main");
  const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>({
    hello: services.hello,
    transport: {
      send: (text) => session.receive(parseMessage(text) as ClientMessage),
      subscribe(listener) {
        deliver = listener;
        return () => {
          deliver = () => {};
        };
      },
      async close() {
        deliver({ kind: "closed" });
      },
    },
  });
  try {
    await client.ready;
    expect(await client.invoke("memo.read", null)).toBe("initial");
    const saved: string[] = [];
    const off = await client.listen(
      "memo.saved",
      (event) => {
        saved.push(event.payload);
      },
      { onError() {} },
    );
    expect(await client.invoke("memo.save", "hello")).toBeNull();
    expect(await client.invoke("memo.read", null)).toBe("hello");
    expect(saved).toEqual(["hello"]);
    await expect(client.invoke("memo.save", "x".repeat(33))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(client.invoke("settings.save", 1)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await off();
  } finally {
    await client.close();
    await core.stop();
  }
});

test("duplicate module commands fail before replacing a handler", () => {
  const original = defineModule("memo").command("save", contract, () => null);
  expect(() => original.command("save", contract, () => null)).toThrow(
    'Duplicate command "memo.save"',
  );
  expect(Object.keys(original.commands)).toEqual(["memo.save"]);
});

test("same local command name in different namespaces is allowed", () => {
  expect(Object.keys(app.commands)).toEqual(["memo.save", "memo.read", "settings.save"]);
});

test("duplicate final names report both module positions, including overlapping prefixes", () => {
  for (const other of [memo, defineModule("memo").command("save", contract, () => null)])
    expect(() => defineApp({ modules: [memo, other] })).toThrow(
      'Duplicate command "memo.save": module "memo" (modules[0]) conflicts with module "memo" (modules[1]).',
    );
  const first = defineModule("memo.archive").command("save", contract, () => null);
  const second = defineModule("memo").command("archive.save", contract, () => null);
  expect(() => defineApp({ modules: [first, second] })).toThrow(
    'Duplicate command "memo.archive.save"',
  );
});

test("app and plugin collisions fail before plugin setup", () => {
  expect(() => defineApp({ modules: [memo], commands: memo.commands })).toThrow(
    'app.commands conflicts with module "memo" (modules[0])',
  );
  let setups = 0;
  const plugin: PluginDefinition = {
    name: "storage",
    version: "1",
    commands: memo.commands,
    setup() {
      setups++;
    },
  };
  expect(() => defineApp({ modules: [memo], plugins: [plugin] })).toThrow(
    'module "memo" (modules[0]) conflicts with plugin "storage" (plugins[0])',
  );
  expect(() =>
    defineApp({ modules: [], plugins: [plugin, { ...plugin, name: "backup" }] }),
  ).toThrow('plugin "storage" (plugins[0]) conflicts with plugin "backup" (plugins[1])');
  expect(setups).toBe(0);
});

test("events reject duplicates and remain separate from command names", () => {
  const module = defineModule("memo")
    .command("saved", contract, () => null)
    .event("saved", textSchema);
  expect(() => module.event("saved", textSchema)).toThrow('Duplicate event "memo.saved"');
  expect(() =>
    defineApp({ modules: [module, defineModule("memo").event("saved", textSchema)] }),
  ).toThrow('Duplicate event "memo.saved"');
  expect(() => defineApp({ modules: [module], events: module.events })).toThrow(
    "app.events conflicts",
  );
  expect(() =>
    defineApp({
      modules: [module],
      plugins: [{ name: "events", version: "1", events: module.events }],
    }),
  ).toThrow('Duplicate event "memo.saved"');
  expect(Object.keys(defineApp({ modules: [module] }).commands)).toEqual(["memo.saved"]);
});

test("builder snapshots do not change earlier branches or composed apps", () => {
  const base = defineModule("memo");
  const first = base.command("save", contract, () => null);
  const composed = defineApp({ modules: [first] });
  const next = first.command("read", contract, () => null);
  expect(Object.keys(base.commands)).toEqual([]);
  expect(Object.keys(first.commands)).toEqual(["memo.save"]);
  expect(Object.keys(next.commands)).toEqual(["memo.save", "memo.read"]);
  expect(Object.keys(composed.commands)).toEqual(["memo.save"]);
  expect(() => {
    Object.assign(composed.commands, next.commands);
  }).toThrow();
});

test("empty apps and direct definitions produce ordinary AppDefinitions", () => {
  const definition = command({ ...contract, handle: () => null });
  const plugins: PluginDefinition[] = [{ name: "lifecycle", version: "1" }];
  const composed = defineApp({
    modules: [],
    commands: { save: definition },
    events: { saved: textSchema },
    plugins,
  });
  expect(composed.commands.save).toBe(definition);
  expect(composed.events.saved).toBe(textSchema);
  expect(composed.plugins).toEqual(plugins);
  expect(defineApp({ modules: [] })).toEqual({ commands: {}, events: {} });
});

test("invalid and reserved qualified names fail during authoring", () => {
  for (const name of ["", "has space"])
    expect(() => defineModule(name)).toThrow("invalid module name");
  for (const name of ["", "has space", "x".repeat(128)])
    expect(() => defineModule("memo").command(name, contract, () => null)).toThrow(
      "invalid command name",
    );
  expect(() => defineModule("bunaway").command("capabilities", contract, () => null)).toThrow(
    "reserved",
  );
  expect(
    Object.keys(
      defineModule("memo").command("bunaway.capabilities", contract, () => null).commands,
    ),
  ).toEqual(["memo.bunaway.capabilities"]);
});

// These assertions verify frontend inference and generic SDK consumers.
export function checkModuleTypes(client: Client<CommandsOf<typeof app>, EventsOf<typeof app>>) {
  const read: Promise<string> = client.invoke("memo.read", null);
  const save: Promise<null> = client.invoke("memo.save", "hello");
  const setting: Promise<number> = client.invoke("settings.save", 1);
  void [read, save, setting];
  // @ts-expect-error local command names are not frontend command names
  client.invoke("save", "hello");
  // @ts-expect-error composed commands retain input types
  client.invoke("memo.save", 1);
  // @ts-expect-error composed commands retain output types
  const wrong: Promise<number> = client.invoke("memo.read", null);
  void wrong;
  client.listen(
    "memo.saved",
    (event) => {
      const text: string = event.payload;
      void text;
    },
    { onError() {} },
  );
  // @ts-expect-error unknown composed event
  client.listen("memo.missing", () => {}, { onError() {} });
  const base = defineModule("memo");
  // @ts-expect-error earlier builders do not gain later commands
  base.commands["memo.save"];
  const empty = defineApp({ modules: [] });
  // @ts-expect-error empty apps do not widen to every command name
  empty.commands["memo.save"];
  moduleAsApp([memo]);
  // @ts-expect-error composed registries are immutable snapshots
  app.commands["memo.save"] = memo.commands["memo.save"];
  // @ts-expect-error module registries are immutable snapshots
  memo.events["memo.saved"] = textSchema;
}

function moduleAsApp<const M extends readonly ModuleDefinition[]>(modules: M): AppDefinition {
  return defineApp({ modules });
}

function conditionalApp(condition: boolean) {
  return defineApp({ modules: [condition ? memo : settings] });
}

function mixedApp(condition: boolean) {
  return defineApp({ modules: [memo, condition ? settings : defineModule("empty")] });
}

export function checkConditionalModuleTypes(
  client: Client<
    CommandsOf<ReturnType<typeof conditionalApp>>,
    EventsOf<ReturnType<typeof conditionalApp>>
  >,
) {
  // @ts-expect-error memo.save is absent when settings was selected
  client.invoke("memo.save", "hello");
  // @ts-expect-error settings.save is absent when memo was selected
  client.invoke("settings.save", 1);
  // @ts-expect-error memo.saved is absent when settings was selected
  client.listen("memo.saved", () => {}, { onError() {} });
  const dynamic: (typeof memo | typeof settings)[] = [];
  const dynamicApp = defineApp({ modules: dynamic });
  // @ts-expect-error an array element type does not guarantee registration
  dynamicApp.commands["memo.save"];
}

export function checkMixedModuleTypes(client: Client<CommandsOf<ReturnType<typeof mixedApp>>>) {
  const result: Promise<string> = client.invoke("memo.read", null);
  void result;
  // @ts-expect-error settings is optional but memo remains registered
  client.invoke("settings.save", 1);
}
