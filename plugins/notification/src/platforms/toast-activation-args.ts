import { IDENTIFIER_SOURCE } from "#notification/contract";

/** Identifies arguments this plugin wrote; a later format change bumps the number. */
const ARGUMENT_VERSION = "bunaway1";
/** Activator arguments of the reply submit button. Regular buttons use ACTION_ARGUMENT_PREFIX plus their id. */
const REPLY_TARGET = "reply";
/** Identifier ids never contain ':', so this prefix cannot collide with REPLY_TARGET. */
const ACTION_TARGET_PREFIX = "action:";
/**
 * Longest argument string the plugin writes: version, two identifiers, separators and an action target.
 * Anything longer did not come from this plugin and is dropped before parsing.
 */
export const MAX_ACTIVATION_ARGUMENT_LENGTH = 128;

/** What the user clicked: the toast body, the reply submit button or one declared action button. */
export type ActivationTarget =
  | {
      kind: "body";
    }
  | {
      kind: "reply";
    }
  | {
      kind: "action";
      actionId: string;
    };

export type ParsedActivation = {
  id: string;
  group: string;
  target: ActivationTarget;
};

// The identifiers cannot contain ';' or ':', so one anchored pattern accepts exactly what
// `activationArguments` writes. `(?![\s\S])` rejects a trailing newline that `$` would accept.
const ARGUMENT_PATTERN = new RegExp(
  `^${ARGUMENT_VERSION};(${IDENTIFIER_SOURCE});(${IDENTIFIER_SOURCE});(|${REPLY_TARGET}|${ACTION_TARGET_PREFIX}(${IDENTIFIER_SOURCE}))(?![\\s\\S])`,
);

/**
 * Arguments stored in the toast XML: the `launch` attribute for a body click and the `arguments`
 * of each button. They carry the identity so a click after the app restarted can be attributed
 * without any in-memory state.
 */
export function activationArguments(
  identity: {
    id: string;
    group: string;
  },
  target: ActivationTarget,
): string {
  const suffix = {
    body: "",
    reply: REPLY_TARGET,
    action: `${ACTION_TARGET_PREFIX}${target.kind === "action" ? target.actionId : ""}`,
  }[target.kind];
  return `${ARGUMENT_VERSION};${identity.group};${identity.id};${suffix}`;
}

/**
 * Parse arguments handed back by Windows. Windows passes them to any process that can reach the
 * activator, so only the exact format `activationArguments` writes is accepted: anything else
 * (wrong version, unknown target, extra fields, oversized text) yields undefined.
 */
export function parseActivationArguments(
  text: string,
): ParsedActivation | undefined {
  if (text.length > MAX_ACTIVATION_ARGUMENT_LENGTH) {
    return undefined;
  }
  const match = ARGUMENT_PATTERN.exec(text);
  const group = match?.[1];
  const id = match?.[2];
  const target = match?.[3];
  if (group === undefined || id === undefined || target === undefined) {
    return undefined;
  }
  const actionId = match?.[4];
  if (actionId !== undefined) {
    return {
      id,
      group,
      target: {
        kind: "action",
        actionId,
      },
    };
  }
  return {
    id,
    group,
    target: {
      kind: target === REPLY_TARGET ? "reply" : "body",
    },
  };
}
