import { posix } from "node:path";
import { toUSVString } from "node:util";
import {
  AUTOSTART_ARGUMENT,
  AUTOSTART_HIDDEN_ARGUMENT,
} from "@bunaway/protocol";
import type { AppLaunch } from "#autostart/contract";
import {
  invalid,
  rejectDevelopmentHostOptions,
} from "#autostart/platforms/launch";

/** Largest plist this adapter reads; a managed plist holds a few short strings. */
export const MAX_PLIST_BYTES = 64 * 1024;
/** Deepest nesting the reader follows; a managed plist nests three levels. */
const MAX_PLIST_DEPTH = 8;
const PLIST_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
`;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;
const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^<>]*>|<(\/?)([A-Za-z]+)(?:\s[^<>]*?)?(\/?)>|[^<]+/y;
/** Self-closing elements: booleans and the empty string. */
const EMPTY_VALUES = new Map<string, PlistValue>([
  [
    "true",
    true,
  ],
  [
    "false",
    false,
  ],
  [
    "string",
    "",
  ],
]);
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A managed launch agent as read back from disk. */
export type LaunchAgent = {
  label: string;
  /** `null` when ProgramArguments is absent or is not an array of strings. */
  programArguments: string[] | null;
  runAtLoad: boolean;
};

type Token =
  | {
      kind: "open" | "close" | "empty";
      name: string;
    }
  | {
      kind: "text";
      text: string;
    };
type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
type PlistDict = Map<string, PlistValue>;

/** Reject text that XML 1.0 cannot carry unchanged, so what is written is what launchd reads. */
function validateText(value: string): void {
  if (
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
    /[\u0000-\u001f\u007f￾￿]/.test(value) ||
    toUSVString(value) !== value
  ) {
    invalid(
      "Autostart arguments must be well-formed strings without control characters.",
    );
  }
}

/** Escape text for an XML element body or attribute. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build the launch command from trusted host paths, never a caller-selected executable. */
export function programArguments(
  app: AppLaunch,
  args: readonly string[],
  hidden = false,
): string[] {
  const executable = app.launch.executablePath;
  validateText(executable);
  if (!posix.isAbsolute(executable)) {
    invalid("Autostart requires an absolute macOS executable path.");
  }
  if (hidden && app.supportsHiddenStart !== true) {
    invalid("Hidden autostart requires desktop.tray in the app definition.");
  }
  rejectDevelopmentHostOptions(app, args);
  const result = [
    executable,
    ...app.launch.args,
    hidden ? AUTOSTART_HIDDEN_ARGUMENT : AUTOSTART_ARGUMENT,
    ...args,
  ];
  for (const value of result) {
    validateText(value);
  }
  return result;
}

/** Serialize the plist launchd loads at the next login: Label, ProgramArguments, RunAtLoad. */
export function buildLaunchAgent(label: string, args: readonly string[]) {
  const strings = args
    .map((value) => `\t\t<string>${escapeXml(value)}</string>\n`)
    .join("");
  return `${PLIST_HEADER}<dict>
\t<key>Label</key>
\t<string>${escapeXml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings}\t</array>
\t<key>RunAtLoad</key>
\t<true/>
</dict>
</plist>
`;
}

function tokenize(xml: string): Token[] | null {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < xml.length) {
    const match = TOKEN.exec(xml);
    if (!match) {
      return null;
    }
    const [text, closing, name, empty] = match;
    if (name) {
      let kind: "open" | "close" | "empty" = "open";
      if (empty) {
        kind = "empty";
      } else if (closing) {
        kind = "close";
      }
      tokens.push({
        kind,
        name,
      });
    } else if (!text.startsWith("<")) {
      tokens.push({
        kind: "text",
        text,
      });
    }
  }
  return tokens;
}

function decode(text: string): string | null {
  if (text.replace(ENTITY, "").includes("&")) {
    return null;
  }
  return text.replace(ENTITY, (_match, hex, decimal, name) => {
    if (name) {
      return ENTITIES[name] ?? "";
    }
    const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

class Reader {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private skipSpace(): void {
    for (;;) {
      const token = this.tokens[this.index];
      if (token?.kind !== "text" || token.text.trim() !== "") {
        return;
      }
      this.index += 1;
    }
  }

  private peek(): Token | undefined {
    this.skipSpace();
    return this.tokens[this.index];
  }

  /** Consume the closing tag for `name`. */
  private close(name: string): boolean {
    const token = this.peek();
    if (token?.kind !== "close" || token.name !== name) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private key(): string | null {
    const token = this.peek();
    if (token?.kind !== "open" || token.name !== "key") {
      return null;
    }
    this.index += 1;
    return this.scalar("key");
  }

  /** Read the text between `<name>` and `</name>`; the opening tag is already consumed. */
  private scalar(name: string): string | null {
    let text = "";
    const token = this.tokens[this.index];
    if (token?.kind === "text") {
      text = token.text;
      this.index += 1;
    }
    const end = this.tokens[this.index];
    if (end?.kind !== "close" || end.name !== name) {
      return null;
    }
    this.index += 1;
    return decode(text);
  }

  private array(depth: number): PlistValue[] | null {
    const items: PlistValue[] = [];
    while (!this.close("array")) {
      const item = this.value(depth + 1);
      if (item === null) {
        return null;
      }
      items.push(item);
    }
    return items;
  }

  private dict(depth: number): PlistDict | null {
    const dict: PlistDict = new Map();
    while (!this.close("dict")) {
      const key = this.key();
      const entry = key === null ? null : this.value(depth + 1);
      if (key === null || entry === null) {
        return null;
      }
      dict.set(key, entry);
    }
    return dict;
  }

  /** Read the next value; `null` when the document is malformed or uses an unsupported type. */
  value(depth: number): PlistValue | null {
    const token = this.peek();
    if (!token || token.kind === "text" || token.kind === "close") {
      return null;
    }
    this.index += 1;
    if (token.kind === "empty") {
      return EMPTY_VALUES.get(token.name) ?? null;
    }
    switch (token.name) {
      case "string":
        return this.scalar(token.name);
      case "integer":
      case "real": {
        const number = Number(this.scalar(token.name));
        return Number.isFinite(number) ? number : null;
      }
      case "array":
        return depth < MAX_PLIST_DEPTH ? this.array(depth) : null;
      case "dict":
        return depth < MAX_PLIST_DEPTH ? this.dict(depth) : null;
      default:
        return null;
    }
  }

  /** Read `<plist>value</plist>` and require nothing after it. */
  document(): PlistValue | null {
    const open = this.peek();
    if (open?.kind !== "open" || open.name !== "plist") {
      return null;
    }
    this.index += 1;
    const root = this.value(0);
    return root !== null && this.close("plist") && this.peek() === undefined
      ? root
      : null;
  }
}

/** Parse an XML property list; `null` for anything else, including binary plists. */
export function parseLaunchAgent(xml: string): LaunchAgent | null {
  const tokens = tokenize(xml);
  const root = tokens ? new Reader(tokens).document() : null;
  if (!(root instanceof Map)) {
    return null;
  }
  const label = root.get("Label");
  if (typeof label !== "string") {
    return null;
  }
  const args = root.get("ProgramArguments");
  return {
    label,
    programArguments:
      Array.isArray(args) && args.every((item) => typeof item === "string")
        ? (args as string[])
        : null,
    runAtLoad: root.get("RunAtLoad") === true,
  };
}

/** A display string that shell-quotes only the arguments that need it. */
export function displayCommand(args: readonly string[]): string {
  return args
    .map((value) =>
      SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}

/** Compare only the host restart prefix; user-specified application arguments may vary. */
export function matchesLaunch(
  app: AppLaunch,
  args: readonly string[],
): boolean {
  return (
    posix.normalize(args[0] ?? "") ===
      posix.normalize(app.launch.executablePath) &&
    app.launch.args.every((arg, index) => args[index + 1] === arg)
  );
}
