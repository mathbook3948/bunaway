import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord, type Policy, type Schema } from "@bunaway/protocol";
import { validateProject } from "./config.ts";

/** Version of the JSON document written by `bunaway contract`. */
export const CONTRACT_LIST_VERSION = 1;
/** How long importing the app module may take before the child process is stopped. */
export const CONTRACT_IMPORT_TIMEOUT_MS = 30_000;

/** A command or event registered by the app itself or by one of its plugins. */
type Owner = "app" | `plugin:${string}`;

type Registrations = {
  readonly commands: Readonly<
    Record<
      string,
      {
        readonly input: Schema;
        readonly output: Schema;
      }
    >
  >;
  readonly events: Readonly<Record<string, Schema>>;
};

/** Registrations read from the app module: its own and each plugin's. */
type AppDefinition = Registrations & {
  readonly plugins: readonly (Registrations & {
    readonly name: string;
  })[];
};

/** The contract document. Names and lists are sorted so equal inputs give equal bytes. */
export type ContractList = {
  readonly version: typeof CONTRACT_LIST_VERSION;
  readonly commands: readonly {
    readonly name: string;
    readonly owner: Owner;
    readonly input: Schema;
    readonly output: Schema;
    /** Views whose policy lists the command; empty when no UI can call it. */
    readonly views: readonly string[];
  }[];
  readonly events: readonly {
    readonly name: string;
    readonly owner: Owner;
    readonly payload: Schema;
    readonly views: readonly string[];
  }[];
  readonly views: readonly {
    readonly id: string;
    readonly origins: readonly string[];
    readonly commands: readonly string[];
    readonly events: readonly string[];
    /** Host operation names the view may use, never their values. */
    readonly hostPermissions: readonly string[];
  }[];
};

/**
 * Runs in a child Bun process. Importing the app module executes its top-level code, so the
 * result goes to a file: anything the app prints stays out of the document. Schemas are plain
 * data, and commands are reduced to their input and output.
 */
const EXTRACT_SCRIPT = `
const [entry, output] = process.argv.slice(1);
const { default: app } = await import(entry);
if (typeof app !== "object" || app === null || typeof app.commands !== "object" || typeof app.events !== "object") {
  throw new Error("The app entry must default-export a defineApp result.");
}
const commands = (registry) => Object.entries(registry ?? {}).map(([name, command]) => ({ name, input: command.input, output: command.output }));
const events = (registry) => Object.entries(registry ?? {}).map(([name, payload]) => ({ name, payload }));
const plugins = (app.plugins ?? []).map((plugin) => ({ name: plugin.name, commands: commands(plugin.commands), events: events(plugin.events) }));
await Bun.write(output, JSON.stringify({ commands: commands(app.commands), events: events(app.events), plugins }));
// Handles the app opened at top level (servers, timers) must not keep this process alive.
process.exit(0);
`;

/** Orders names by UTF-16 code unit so the result does not depend on the locale. */
function compareNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function sorted(values: readonly string[]): string[] {
  return [
    ...values,
  ].sort(compareNames);
}

/** Narrows a value read from the child's file to a record, naming the field in the error. */
function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`The app definition has an invalid ${field}.`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`The app definition has an invalid ${field}.`);
  }
  return value;
}

function expectList(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`The app definition has an invalid ${field}.`);
  }
  return value;
}

/**
 * Reads the child's list form into name-keyed registrations. The file is the child's own output
 * and is not a wire message, so only its structure is checked, with no size or depth limit.
 * Schema bodies are the values the app registered, which its definition validated, so they are
 * carried as written.
 */
function toRegistrations(value: Record<string, unknown>): Registrations {
  const commands: Record<string, Registrations["commands"][string]> = {};
  for (const item of expectList(value.commands, "commands")) {
    const entry = expectRecord(item, "command");
    commands[expectString(entry.name, "command name")] = {
      input: expectRecord(entry.input, "command input"),
      output: expectRecord(entry.output, "command output"),
    };
  }
  const events: Record<string, Schema> = {};
  for (const item of expectList(value.events, "events")) {
    const entry = expectRecord(item, "event");
    events[expectString(entry.name, "event name")] = expectRecord(
      entry.payload,
      "event payload",
    );
  }
  return {
    commands,
    events,
  };
}

function toDefinition(value: unknown): AppDefinition {
  const root = expectRecord(value, "root");
  return {
    ...toRegistrations(root),
    plugins: expectList(root.plugins, "plugins").map((item) => {
      const plugin = expectRecord(item, "plugin");
      return {
        name: expectString(plugin.name, "plugin name"),
        ...toRegistrations(plugin),
      };
    }),
  };
}

/** Reads one app's registrations by importing its entry in an isolated Bun process. */
export async function readAppDefinition(
  appEntry: string,
  directory: string,
  timeoutMs = CONTRACT_IMPORT_TIMEOUT_MS,
): Promise<AppDefinition> {
  const scratch = await mkdtemp(resolve(tmpdir(), "bunaway-contract-"));
  try {
    const output = resolve(scratch, "definition.json");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        EXTRACT_SCRIPT,
        pathToFileURL(appEntry).href,
        output,
      ],
      {
        cwd: directory,
        stdin: "ignore",
        // The app's own output is the developer's to read; it must not reach the document.
        stdout: process.stderr.fd,
        stderr: "inherit",
      },
    );
    let timedOut = false;
    // SIGKILL because an app may ignore SIGTERM; waiting on it would hang the CLI.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const code = await child.exited;
      if (code !== 0) {
        throw new Error(
          timedOut
            ? `Importing the app entry took longer than ${timeoutMs} ms.`
            : `Importing the app entry failed (exit ${code}).`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    // An app that exits the process itself finishes with code 0 before writing the result.
    if (!(await Bun.file(output).exists())) {
      throw new Error("The app entry ended the process before it was read.");
    }
    return toDefinition(JSON.parse(await readFile(output, "utf8")));
  } finally {
    await rm(scratch, {
      recursive: true,
      force: true,
    });
  }
}

/** Names each registered entry's owner; defineApp already rejects a name two owners register. */
function ownedEntries<T>(
  app: Readonly<Record<string, T>>,
  plugins: readonly {
    readonly name: string;
    readonly entries: Readonly<Record<string, T>>;
  }[],
): Map<
  string,
  {
    owner: Owner;
    value: T;
  }
> {
  const owned = new Map<
    string,
    {
      owner: Owner;
      value: T;
    }
  >();
  const add = (owner: Owner, entries: Readonly<Record<string, T>>) => {
    for (const [name, value] of Object.entries(entries)) {
      owned.set(name, {
        owner,
        value,
      });
    }
  };
  add("app", app);
  for (const plugin of plugins) {
    add(`plugin:${plugin.name}`, plugin.entries);
  }
  return owned;
}

/** Entries in name order. */
function byName<T>(entries: ReadonlyMap<string, T>): [
  string,
  T,
][] {
  return [
    ...entries,
  ].sort(([left], [right]) => compareNames(left, right));
}

/** Views that list `name`, in id order. */
function viewsListing(
  policy: Policy,
  kind: "commands" | "events",
  name: string,
): string[] {
  return sorted(
    policy.views
      .filter((view) => view[kind].includes(name))
      .map(({ id }) => id),
  );
}

/** Throws naming every policy entry that no app or plugin registers. */
function assertPolicyNamesExist(
  policy: Policy,
  commandNames: ReadonlySet<string>,
  eventNames: ReadonlySet<string>,
): void {
  const missing = policy.views.flatMap((view) => [
    ...view.commands
      .filter((name) => !commandNames.has(name))
      .map((name) => `view "${view.id}" lists command "${name}"`),
    ...view.events
      .filter((name) => !eventNames.has(name))
      .map((name) => `view "${view.id}" lists event "${name}"`),
  ]);
  if (missing.length > 0) {
    throw new Error(
      `policy.json names entries the app does not register: ${missing.join("; ")}.`,
    );
  }
}

/** Joins the app's registrations with the policy's per-view exposure into the contract document. */
export function buildContractList(
  policy: Policy,
  definition: AppDefinition,
): ContractList {
  const commands = ownedEntries(
    definition.commands,
    definition.plugins.map((plugin) => ({
      name: plugin.name,
      entries: plugin.commands,
    })),
  );
  const events = ownedEntries(
    definition.events,
    definition.plugins.map((plugin) => ({
      name: plugin.name,
      entries: plugin.events,
    })),
  );
  assertPolicyNamesExist(
    policy,
    new Set(commands.keys()),
    new Set(events.keys()),
  );
  return {
    version: CONTRACT_LIST_VERSION,
    commands: byName(commands).map(([name, { owner, value }]) => ({
      name,
      owner,
      input: value.input,
      output: value.output,
      views: viewsListing(policy, "commands", name),
    })),
    events: byName(events).map(([name, { owner, value }]) => ({
      name,
      owner,
      payload: value,
      views: viewsListing(policy, "events", name),
    })),
    views: [
      ...policy.views,
    ]
      .sort((left, right) => compareNames(left.id, right.id))
      .map((view) => ({
        id: view.id,
        origins: sorted(view.origins),
        commands: sorted(view.commands),
        events: sorted(view.events),
        hostPermissions: sorted(view.host.permissions),
      })),
  };
}

/** Validates the project, reads its app definition and returns the contract document as JSON text. */
export async function contractListText(directory: string): Promise<string> {
  const project = await validateProject(directory);
  const definition = await readAppDefinition(project.appEntry, project.root);
  return `${JSON.stringify(buildContractList(project.policy, definition), null, 2)}\n`;
}
