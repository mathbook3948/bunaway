import { BunawayError } from "@bunaway/protocol";
import type { AppLaunch } from "#autostart/contract";

/** Throw the caller-facing error for an input or identity the platform cannot register. */
export function invalid(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/** The identity includes the launch mode so development cannot overwrite the installed app. */
export function registrationName(app: AppLaunch): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(app.id)) {
    invalid("Invalid autostart app identifier.");
  }
  // A mode prefix, rather than a suffix, also separates IDs ending in .development.
  return `bunaway.${app.launch.mode}.${app.id}`;
}

/** Development host switches describe one dev session and must not be persisted. */
export function rejectDevelopmentHostOptions(
  app: AppLaunch,
  args: readonly string[],
): void {
  if (
    app.launch.mode === "development" &&
    [
      "--devtools",
      "--dev-url",
    ].includes(args[0] ?? "")
  ) {
    invalid("Autostart cannot persist development host options.");
  }
}
