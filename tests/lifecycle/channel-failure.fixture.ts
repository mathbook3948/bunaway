import { runBunApp } from "@bunaway/runtime-bun";

let started = 0;
let cancelled = 0;

// Shared process state lets another document observe cleanup without a test-only runtime hook.
await runBunApp({
  events: {},
  commands: {
    hold: {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      run(_input, { signal }) {
        started++;
        return new Promise<null>((resolve) => {
          const cancel = () => {
            signal.removeEventListener("abort", cancel);
            cancelled++;
            resolve(null);
          };
          if (signal.aborted) {
            cancel();
          } else {
            signal.addEventListener("abort", cancel);
          }
        });
      },
    },
    status: {
      input: {
        const: null,
      },
      output: {
        type: "array",
        items: {
          type: "integer",
        },
      },
      async run() {
        return [
          process.pid,
          started,
          cancelled,
        ];
      },
    },
    large: {
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      async run() {
        return "x".repeat(512 * 1024);
      },
    },
  },
});
