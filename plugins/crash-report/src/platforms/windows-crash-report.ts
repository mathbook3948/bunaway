import { mkdirSync } from "node:fs";
import { BunawayError } from "@bunaway/plugin";
import { checkHresult } from "@bunaway/plugin/win32";
import {
  type CrashDump,
  type CrashReportInstance,
  type CrashReportRemoveInput,
  type CrashReportRemoveResult,
  MAX_CRASH_DUMPS,
} from "#crash-report/contract";
import {
  pruneDumps,
  removeDump,
  scanDumps,
} from "#crash-report/platforms/dump-folder";

/** The two Windows Error Reporting calls the adapter makes; both return an HRESULT. */
export interface WerBindings {
  /** WerRegisterAppLocalDump with a folder path relative to the user's local app data directory. */
  register(relativeFolder: string): number;
  /** WerUnregisterAppLocalDump. */
  unregister(): number;
}

/**
 * Registers this process for local dumps in one host-chosen folder and reports what is there. The
 * registration belongs to the process, so `dispose` leaves it in place and an exit during shutdown is
 * still captured.
 */
export class WindowsCrashReport implements CrashReportInstance {
  private registered = false;
  private disposed = false;

  constructor(
    private readonly bindings: WerBindings,
    /** Absolute dump folder. */
    private readonly folder: string,
    /** The same folder relative to the local app data directory, as Windows Error Reporting wants it. */
    private readonly relativeFolder: string,
    private readonly release: () => void,
  ) {}

  private assertActive(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Crash report adapter is disposed.",
      });
    }
  }

  enable(): null {
    this.assertActive();
    if (this.registered) {
      return null;
    }
    mkdirSync(this.folder, {
      recursive: true,
    });
    pruneDumps(this.folder);
    checkHresult(
      this.bindings.register(this.relativeFolder),
      "WerRegisterAppLocalDump",
    );
    this.registered = true;
    return null;
  }

  disable(): null {
    this.assertActive();
    if (!this.registered) {
      return null;
    }
    checkHresult(this.bindings.unregister(), "WerUnregisterAppLocalDump");
    this.registered = false;
    return null;
  }

  list(): CrashDump[] {
    this.assertActive();
    pruneDumps(this.folder);
    return scanDumps(this.folder)
      .slice(0, MAX_CRASH_DUMPS)
      .map(({ id, createdAtMs, sizeBytes, kind }) => ({
        id,
        createdAtMs,
        sizeBytes,
        kind,
      }));
  }

  remove(input: CrashReportRemoveInput): CrashReportRemoveResult {
    this.assertActive();
    return {
      removed: removeDump(this.folder, input.id),
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.release();
  }
}
