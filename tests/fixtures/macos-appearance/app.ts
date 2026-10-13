import { defineApp } from "@bunaway/backend";
import { appearance, appearancePlugin } from "@bunaway/plugin-appearance";
import { windowsPlugin } from "@bunaway/plugin-windows";

const reports: unknown[] = [];
export default defineApp({
  modules: [],
  plugins: [
    appearancePlugin,
    windowsPlugin,
  ],
  commands: {
    "test.backend": {
      input: {
        const: null,
      },
      output: {},
      async run() {
        try {
          return await appearance.getPreferences();
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "PERMISSION_DENIED"
          ) {
            return {
              code: error.code,
            };
          }
          throw error;
        }
      },
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
