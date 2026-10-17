import type { NativeMenuRole } from "@bunaway/plugin-api/native";

/** `document.execCommand` name for each menu role. */
const EXEC_COMMANDS = {
  undo: "undo",
  redo: "redo",
  cut: "cut",
  copy: "copy",
  paste: "paste",
  selectAll: "selectAll",
} as const satisfies Record<NativeMenuRole, string>;

/** What the page-side script reports about the document it ran the command in. */
export type EditCommandOutcome = {
  outcome: "executed" | "refused" | "cross-origin-frame";
  /** `hasFocus()` of the document that received the command. */
  focused: boolean;
};

/** Where a finished editing command is reported; none of these may throw into the caller. */
export type EditCommandReport = {
  /** The command could not run or the document refused it. */
  failed(reason: string): void;
  /** The command was deliberately not run, for example in a cross-origin frame. */
  skipped(reason: string): void;
  /** The command ran in a document; observed by diagnostics and tests. */
  executed?(result: EditCommandOutcome): void;
};

/** Host-side verdict for one finished editing command. */
export type EditCommandVerdict =
  | {
      kind: "executed";
      result: EditCommandOutcome;
    }
  | {
      kind: "skipped";
      reason: string;
      result: EditCommandOutcome;
    }
  | {
      kind: "failed";
      reason: string;
    };

/**
 * Build the `Runtime.evaluate` parameters that run a role in the focused document.
 *
 * The script follows `activeElement` from the top document into nested same-origin frames and
 * runs `execCommand` where focus ends. `userGesture` lets copy and cut write the clipboard.
 * A frame whose `contentDocument` is null is cross-origin and is left untouched. The command
 * is embedded through JSON.stringify and comes from a fixed set.
 */
export function editCommandEvaluateParameters(role: NativeMenuRole): object {
  return {
    expression: `(() => {
  let doc = document;
  while (doc.activeElement && /^i?frame$/i.test(doc.activeElement.tagName)) {
    const next = doc.activeElement.contentDocument;
    if (!next) {
      return { outcome: "cross-origin-frame", focused: false };
    }
    doc = next;
  }
  const executed = doc.execCommand(${JSON.stringify(EXEC_COMMANDS[role])});
  return { outcome: executed ? "executed" : "refused", focused: doc.hasFocus() };
})()`,
    userGesture: true,
    returnByValue: true,
  };
}

const OUTCOMES: readonly string[] = [
  "executed",
  "refused",
  "cross-origin-frame",
];

/** Classify a finished `Runtime.evaluate` of an editing script; it never throws. */
export function interpretEditCommandResult(
  hresult: number,
  json: string,
): EditCommandVerdict {
  if (hresult < 0) {
    return {
      kind: "failed",
      reason: `0x${(hresult >>> 0).toString(16)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      kind: "failed",
      reason: "invalid-result",
    };
  }
  const reply = parsed as {
    exceptionDetails?: unknown;
    result?: {
      value?: Partial<EditCommandOutcome>;
    };
  } | null;
  if (reply?.exceptionDetails) {
    return {
      kind: "failed",
      reason: "script-exception",
    };
  }
  const value = reply?.result?.value;
  if (
    !value ||
    typeof value.outcome !== "string" ||
    !OUTCOMES.includes(value.outcome) ||
    typeof value.focused !== "boolean"
  ) {
    return {
      kind: "failed",
      reason: "invalid-result",
    };
  }
  const result = value as EditCommandOutcome;
  if (result.outcome === "cross-origin-frame") {
    return {
      kind: "skipped",
      reason: "cross-origin-frame",
      result,
    };
  }
  if (result.outcome === "refused") {
    return {
      kind: "failed",
      reason: `execCommand-refused (focused: ${result.focused})`,
    };
  }
  return {
    kind: "executed",
    result,
  };
}
