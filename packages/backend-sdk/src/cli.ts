import { parseArgs, toUSVString } from "node:util";
import { isRecord } from "@bunaway/protocol";
import { z } from "zod";

/** One command-scoped flag parsed by Bun's node:util implementation. Defaults belong in the Zod schema. */
export type CLIOption = {
  readonly type: "string" | "boolean";
  readonly short?: string;
  readonly multiple?: boolean;
  readonly description?: string;
};
/** A leaf command validates parsed values and positionals with its app-owned Zod schema. */
export type CLICommand = {
  readonly description?: string;
  readonly options?: Readonly<Record<string, CLIOption>>;
  readonly schema: z.ZodType;
};
/** A group selects its next subcommand before parsing that command's flags. */
export type CLIGroup = {
  readonly description?: string;
  readonly commands: Readonly<Record<string, CLICommand | CLIGroup>>;
};
/** App command tree. The display name is used in generated help, never executed. */
export type CLIDefinition = (CLICommand | CLIGroup) & {
  readonly name: string;
};
/** The selected command and its schema-transformed result, inferred through nested subcommands. */
export type CLIMatch<
  D,
  P extends string = "",
  Depth extends readonly unknown[] = [],
> = D extends {
  readonly schema: infer S extends z.ZodType;
}
  ? {
      kind: "match";
      command: P;
      data: z.output<S>;
    }
  : Depth["length"] extends 8
    ? never
    : D extends {
          readonly commands: infer C;
        }
      ? {
          [K in keyof C & string]: CLIMatch<
            C[K],
            P extends "" ? K : `${P} ${K}`,
            [
              ...Depth,
              unknown,
            ]
          >;
        }[keyof C & string]
      : never;
/** Help does not run the selected command's business-input schema. */
export type CLIHelp = {
  kind: "help";
  command: string;
  help: string;
};
/** Recoverable syntax or schema failure. Parsing does not print or terminate the app. */
export type CLIError = {
  kind: "error";
  command: string;
  help: string;
  error: {
    code: "INVALID_ARGUMENT";
    reason: "arguments" | "schema";
    message: string;
    issues: {
      path: string[];
      message: string;
    }[];
  };
};
/** Discriminated parse outcome; a match's data comes from the selected app schema. */
export type CLIResult<
  M = {
    kind: "match";
    command: string;
    data: unknown;
  },
> = M | CLIHelp | CLIError;

type CompiledNode = {
  description: string;
} & (
  | {
      kind: "command";
      schema: z.ZodType;
      options: Record<string, CLIOption>;
    }
  | {
      kind: "group";
      commands: Map<string, CompiledNode>;
    }
);
const MAX_ARGS = 256;
const MAX_ARG_UNITS = 4096;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_COMMANDS = 128;
const MAX_OPTIONS = 64;
const NAME = /^[a-z][a-z0-9-]{0,63}$(?![\s\S])/;
const optionSchema = z.strictObject({
  type: z.enum([
    "string",
    "boolean",
  ]),
  short: z
    .string()
    .regex(/^[a-zA-Z]$(?![\s\S])/)
    .exactOptional(),
  multiple: z.boolean().exactOptional(),
  description: z.string().max(1024).exactOptional(),
});

function isText(value: unknown, maxUnits: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxUnits &&
    toUSVString(value) === value &&
    Array.from(value).every(
      (char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f,
    )
  );
}

/** Snapshot the command tree and reject cycles, conflicting aliases and malformed definitions. */
function compile(definition: CLIDefinition) {
  if (!isText(definition.name, 128) || !definition.name.length) {
    throw new TypeError("Invalid CLI name.");
  }
  const ancestors = new Set<CLICommand | CLIGroup>();
  let count = 0;
  function visit(node: CLICommand | CLIGroup, depth: number): CompiledNode {
    if (
      !node ||
      typeof node !== "object" ||
      ancestors.has(node) ||
      depth > MAX_DEPTH ||
      ++count > MAX_COMMANDS
    ) {
      throw new TypeError("Invalid CLI command tree.");
    }
    ancestors.add(node);
    try {
      const description = node.description ?? "";
      if (!isText(description, 1024)) {
        throw new TypeError("Invalid CLI description.");
      }
      const allowed = [
        "description",
        ...(depth === 0
          ? [
              "name",
            ]
          : []),
        ...("schema" in node
          ? [
              "schema",
              "options",
            ]
          : [
              "commands",
            ]),
      ];
      if (Object.keys(node).some((key) => !allowed.includes(key))) {
        throw new TypeError("Unknown CLI definition field.");
      }
      if ("schema" in node) {
        if (!(node.schema instanceof z.ZodType)) {
          throw new TypeError("CLI commands require a Zod schema.");
        }
        const source = node.options ?? {};
        if (!isRecord(source) || Object.keys(source).length > MAX_OPTIONS) {
          throw new TypeError("Invalid CLI options.");
        }
        const aliases = new Set([
          "h",
        ]);
        const options: Record<string, CLIOption> = Object.fromEntries(
          Object.entries(source).map(([name, value]) => {
            const parsed = optionSchema.safeParse(value);
            if (
              !NAME.test(name) ||
              name === "help" ||
              !parsed.success ||
              !isText(parsed.data.description ?? "", 1024)
            ) {
              throw new TypeError("Invalid or reserved CLI option.");
            }
            if (parsed.data.short) {
              if (aliases.has(parsed.data.short)) {
                throw new TypeError("Duplicate or reserved CLI short option.");
              }
              aliases.add(parsed.data.short);
            }
            return [
              name,
              Object.freeze(parsed.data),
            ];
          }),
        );
        return {
          kind: "command",
          description,
          schema: node.schema,
          options,
        };
      }
      if (
        !node.commands ||
        typeof node.commands !== "object" ||
        Array.isArray(node.commands)
      ) {
        throw new TypeError("Invalid CLI subcommands.");
      }
      const commands = new Map(
        Object.entries(node.commands).map(([name, child]) => {
          if (!NAME.test(name)) {
            throw new TypeError("Invalid CLI subcommand name.");
          }
          return [
            name,
            visit(child, depth + 1),
          ] as const;
        }),
      );
      if (!commands.size) {
        throw new TypeError("CLI groups require a subcommand.");
      }
      return {
        kind: "group",
        description,
        commands,
      };
    } finally {
      ancestors.delete(node);
    }
  }
  return {
    name: definition.name,
    root: visit(definition, 0),
  };
}

/**
 * Create an app CLI parser for explicit argv, including OpenRequest.argv.
 * Flags are command-scoped; subcommand names precede flags. Bun parses flags,
 * repeated values and --. Zod runs once per match and owns defaults/coercion.
 * Help and errors are returned without I/O, exit, shell or lifecycle effects.
 * A malformed developer definition throws TypeError during construction.
 */
export function defineCLI<const D extends CLIDefinition>(definition: D) {
  const compiled = compile(definition);
  function help(node: CompiledNode, path: readonly string[]) {
    const lines = [
      `Usage: ${[
        compiled.name,
        ...path,
      ].join(
        " ",
      )}${node.kind === "group" ? " <command>" : " [options] [arguments]"}`,
    ];
    if (node.description) {
      lines.push("", node.description);
    }
    if (node.kind === "group") {
      lines.push("", "Commands:");
      for (const [name, child] of node.commands) {
        lines.push(
          `  ${name}${child.description ? `  ${child.description}` : ""}`,
        );
      }
    } else {
      lines.push("", "Options:");
      for (const [name, option] of Object.entries(node.options)) {
        const flag = `${option.short ? `-${option.short}, ` : ""}--${name}${option.type === "string" ? " <value>" : ""}${option.multiple ? " (repeatable)" : ""}`;
        lines.push(
          `  ${flag}${option.description ? `  ${option.description}` : ""}`,
        );
      }
    }
    lines.push("  -h, --help  Show help");
    return lines.join("\n");
  }
  function failure(
    node: CompiledNode,
    path: string[],
    reason: CLIError["error"]["reason"],
    message: string,
    issues: CLIError["error"]["issues"] = [],
  ): CLIError {
    return {
      kind: "error",
      command: path.join(" "),
      help: help(node, path),
      error: {
        code: "INVALID_ARGUMENT",
        reason,
        message,
        issues,
      },
    };
  }
  async function parse(argv: readonly string[]): Promise<CLIResult> {
    const path: string[] = [];
    let node = compiled.root;
    if (
      !Array.isArray(argv) ||
      argv.length > MAX_ARGS ||
      Array.from(argv).some(
        (arg) =>
          typeof arg !== "string" ||
          arg.length > MAX_ARG_UNITS ||
          arg.includes("\0") ||
          toUSVString(arg) !== arg,
      ) ||
      Buffer.byteLength(JSON.stringify(argv)) > MAX_ARG_BYTES
    ) {
      return failure(
        node,
        path,
        "arguments",
        "CLI argv is malformed or exceeds the limit.",
      );
    }
    // Copy before the first await so caller mutation cannot affect an in-flight schema.
    const args = [
      ...argv,
    ];
    while (node.kind === "group") {
      const name = args.shift();
      if (
        name === undefined ||
        ((name === "--help" || name === "-h") && !args.length)
      ) {
        return {
          kind: "help",
          command: path.join(" "),
          help: help(node, path),
        };
      }
      const child = node.commands.get(name);
      if (!child) {
        return failure(
          node,
          path,
          "arguments",
          "Unknown or missing CLI subcommand.",
        );
      }
      path.push(name);
      node = child;
    }
    let input: {
      values: Record<
        string,
        string | boolean | (string | boolean)[] | undefined
      >;
      positionals: string[];
    };
    try {
      const { values, positionals } = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          ...node.options,
          help: {
            type: "boolean",
            short: "h",
          },
        },
      });
      if (values.help) {
        return {
          kind: "help",
          command: path.join(" "),
          help: help(node, path),
        };
      }
      delete values.help;
      input = {
        values,
        positionals,
      };
    } catch (error) {
      return failure(
        node,
        path,
        "arguments",
        error instanceof Error ? error.message : "CLI argument parsing failed.",
      );
    }
    try {
      const parsed = await node.schema.safeParseAsync(input);
      if (!parsed.success) {
        return failure(
          node,
          path,
          "schema",
          "CLI arguments failed validation.",
          parsed.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
          })),
        );
      }
      return {
        kind: "match",
        command: path.join(" "),
        data: parsed.data,
      };
    } catch {
      return failure(node, path, "schema", "CLI argument validation failed.");
    }
  }
  return {
    // The snapshotted runtime tree selects exactly the schema represented by D's command path.
    parse: parse as (
      argv: readonly string[],
    ) => Promise<CLIResult<CLIMatch<D>>>,
    help(path: readonly string[] = []) {
      let node = compiled.root;
      for (const name of path) {
        if (node.kind !== "group") {
          throw new TypeError("Unknown CLI help path.");
        }
        const child = node.commands.get(name);
        if (!child) {
          throw new TypeError("Unknown CLI help path.");
        }
        node = child;
      }
      return help(node, path);
    },
  };
}
