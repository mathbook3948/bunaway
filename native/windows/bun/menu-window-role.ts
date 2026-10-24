import type { NativeMenuWindowRole } from "@bunaway/plugin-api/native";

/** What a window menu role acts on; each member is an existing close, minimize or quit path. */
export type WindowRoleTargets = {
  /** Post the close the caption button sends, so close policy and close requests still decide. */
  requestClose(): void;
  /** Whether the window allows minimizing; Electron's minimize role does nothing when it does not. */
  minimizable(): boolean;
  minimize(): void;
  /** Ask the app to quit with the `quit-command` reason, through its quit confirmation. */
  requestQuit(): void;
  failed(reason: string): void;
  skipped(reason: string): void;
};

export function isWindowRole(role: string): role is NativeMenuWindowRole {
  return role === "close" || role === "minimize" || role === "quit";
}

/** Run a window role. A selection is user input, so a failure is reported and never thrown. */
export function runWindowRole(
  role: NativeMenuWindowRole,
  targets: WindowRoleTargets,
): void {
  try {
    if (role === "quit") {
      targets.requestQuit();
    } else if (role === "close") {
      targets.requestClose();
    } else if (targets.minimizable()) {
      targets.minimize();
    } else {
      targets.skipped("not-minimizable");
    }
  } catch (error) {
    targets.failed(error instanceof Error ? error.message : String(error));
  }
}
