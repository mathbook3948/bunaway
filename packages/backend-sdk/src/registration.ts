import { BunawayError, CAPABILITIES_COMMAND } from "@bunaway/protocol";

export type RegistrationKind = "command" | "event";

// Match Core's registration contract; Core still validates raw AppDefinitions.
export function checkName(name: string, kind: RegistrationKind | "module", owner: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name))
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: `${owner} registered an invalid ${kind} name "${name}".`,
    });
}

export function claimName(
  owners: Map<string, string>,
  name: string,
  kind: RegistrationKind,
  owner: string,
): void {
  checkName(name, kind, owner);
  if (kind === "command" && name === CAPABILITIES_COMMAND)
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: `${owner} cannot register the reserved ${CAPABILITIES_COMMAND} command.`,
    });
  const previous = owners.get(name);
  if (previous !== undefined)
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: `Duplicate ${kind} "${name}": ${previous} conflicts with ${owner}.`,
    });
  owners.set(name, owner);
}
