import { expect, test } from "bun:test";
import { frameworkRoot } from "../../packages/cli/src/files.ts";
import { runManagedCommand } from "../../packages/cli/src/managed-command.ts";

test.each([0, 7])(
  "finite command exit %s closes descendants and preserves the exit result",
  async (code) => {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = listener.port;
    listener.stop(true);
    if (!port) throw new Error("No test port.");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    const server = `Bun.serve({hostname:'127.0.0.1', port:${port}, fetch:()=>new Response('descendant')});`;
    const command = `
    Bun.spawn([process.execPath, '-e', ${JSON.stringify(server)}], {stdin:'ignore', stdout:'inherit', stderr:'inherit'});
    const deadline = Date.now() + 5000;
    while (true) {
      try { if ((await fetch('http://127.0.0.1:${port}/')).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error('Descendant did not start');
      await Bun.sleep(20);
    }
    process.exit(${code});
  `;
    try {
      const result = runManagedCommand(
        [process.execPath, "-e", command],
        import.meta.dir,
        {},
        abort.signal,
        frameworkRoot,
      );
      if (code === 0) await result;
      else await expect(result).rejects.toThrow(`exit ${code}`);
      await expect(
        fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(200) }),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  },
  15000,
);

test.each([0, 7, "cancel"] as const)(
  "command %s waits for SIGTERM-resistant descendants to release their port",
  async (outcome) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
      const port = listener.port;
      listener.stop(true);
      if (!port) throw new Error("No test port.");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error("Test timed out")), 10000);
      const server = `
        process.on('SIGTERM', () => {});
        Bun.serve({hostname:'127.0.0.1', port:${port}, fetch:()=>new Response('descendant')});
      `;
      const command = `
        Bun.spawn([process.execPath, '-e', ${JSON.stringify(server)}], {stdin:'ignore', stdout:'inherit', stderr:'inherit'});
        const deadline = Date.now() + 5000;
        while (true) {
          try { if ((await fetch('http://127.0.0.1:${port}/')).ok) break; } catch {}
          if (Date.now() > deadline) throw new Error('Descendant did not start');
          await Bun.sleep(10);
        }
        ${outcome === "cancel" ? "await Bun.sleep(600000);" : `process.exit(${outcome});`}
      `;
      const result = runManagedCommand(
        [process.execPath, "-e", command],
        import.meta.dir,
        {},
        abort.signal,
        frameworkRoot,
      );
      void result.catch(() => {});
      try {
        if (outcome === "cancel") {
          const deadline = Date.now() + 5000;
          while (true) {
            try {
              if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
            } catch {}
            if (Date.now() > deadline) throw new Error("Descendant did not start");
            await Bun.sleep(10);
          }
          abort.abort(new Error("Command cancelled"));
        }
        if (outcome === "cancel") await expect(result).rejects.toThrow("Command cancelled");
        else if (outcome === 0) await result;
        else await expect(result).rejects.toThrow(`exit ${outcome}`);
        // Rebind synchronously at return, before network I/O can hide an exit race.
        const replacement = Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch: () => new Response("replacement"),
        });
        replacement.stop(true);
      } finally {
        clearTimeout(timer);
        abort.abort();
        await result.catch(() => {});
      }
    }
  },
  30000,
);
