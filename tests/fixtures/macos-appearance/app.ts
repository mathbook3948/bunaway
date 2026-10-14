import { defineApp } from "@bunaway/backend";
import appearance, {
  type AppearancePreferences,
} from "@bunaway/plugin-appearance";
import windows from "@bunaway/plugin-windows";

const reports: unknown[] = [];
let backendResult:
  | AppearancePreferences
  | {
      code: "PERMISSION_DENIED";
    }
  | undefined;
export default defineApp({
  modules: [],
  plugins: [
    appearance,
    windows,
    {
      name: "backend-appearance-check",
      version: "1",
      async setup() {
        // Setup has backend authority. View-initiated commands inherit their
        // calling view's authority, so they cannot serve as backend probes.
        try {
          backendResult = await appearance.getPreferences();
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "PERMISSION_DENIED"
          ) {
            backendResult = {
              code: error.code,
            };
          } else {
            throw error;
          }
        }
      },
    },
  ],
  commands: {
    "test.backend": {
      input: {
        const: null,
      },
      output: {},
      async run() {
        if (backendResult === undefined) {
          throw new Error("Backend appearance probe is not initialized.");
        }
        return backendResult;
      },
    },
    "test.inherited": {
      input: {
        const: null,
      },
      output: {},
      run: () => appearance.getPreferences(),
    },
    "test.report": {
      input: {},
      output: {
        const: null,
      },
      async run(input: unknown) {
        reports.push(input);
        if (reports.length === 2) {
          await Bun.write(
            `${process.env.TMPDIR}/report.json`,
            JSON.stringify(reports),
          );
        }
        return null;
      },
    },
  },
});
