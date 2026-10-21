import { defineNativePlugin } from "@bunaway/plugin";
import { crashReportOperations } from "#crash-report/operations";
import { dispose, initialize } from "#crash-report/platforms/windows";
/**
 * Keep minidumps of this app's host process on Windows through Windows Error Reporting and list them
 * on a later run. Dumps hold process memory, including secrets, so the plugin reports metadata only and
 * never a path or content. Enable it on every run; Windows forgets the registration when the process ends.
 */
export default defineNativePlugin({
  name: "crashReport",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: crashReportOperations,
    },
  },
});

export type {
  CrashDump,
  CrashDumpKind,
  CrashReportRemoveInput,
  CrashReportRemoveResult,
} from "#crash-report/contract";
