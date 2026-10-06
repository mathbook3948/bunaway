import { expect } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Project } from "../../packages/cli/src/config.ts";
import { startDevServer } from "../../packages/cli/src/dev-server.ts";

// Verify the real Vite server, frontend modules/assets and HMR transport.
export async function verifyViteDevelopment(
  project: Project,
  frontend: "sdk" | "vite" = "sdk",
): Promise<void> {
  if (!project.dev) throw new Error("Expected a Vite development configuration.");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = reservation.port;
  reservation.stop(true);
  const url = `http://127.0.0.1:${port}/`;
  const cssName = (await readdir(resolve(project.root, "src"))).find((name) =>
    name.endsWith(".css"),
  );
  if (!cssName) throw new Error("Missing UI stylesheet.");
  const cssPath = resolve(project.root, "src", cssName);
  const original = await readFile(cssPath, "utf8");
  const sourceHtml = await readFile(resolve(project.root, "index.html"), "utf8");
  const server = await startDevServer(
    {
      ...project.dev,
      command: [...project.dev.command, "--port", String(port)],
      url,
      timeoutMs: 15000,
    },
    project.root,
    new AbortController().signal,
    project.frameworkRoot,
  );
  let socket: WebSocket | undefined;
  try {
    const html = (await (await fetch(url)).text()).replaceAll("&#39;", "'");
    expect(html).toContain('src="/@vite/client"');
    expect(html).toContain('src="/src/main.ts"');
    expect(html).toContain("style-src 'self' 'unsafe-inline'");
    expect(html).toContain(`connect-src 'self' ws://127.0.0.1:${port}`);
    const ui = await fetch(new URL("src/main.ts", url));
    expect(ui.ok).toBe(true);
    const script = await ui.text();
    if (frontend === "sdk") {
      const sdkPath = script.match(/from "([^"]+)"/)?.[1];
      if (!sdkPath) throw new Error("Missing served SDK import.");
      const sdk = await fetch(new URL(sdkPath, url));
      expect(sdk.ok).toBe(true);
      expect(await sdk.text()).toContain("createWebViewTransport");
    } else {
      expect(script).toContain("setupCounter");
      expect(script).toContain("Explore Vite");
      const counter = await fetch(new URL("src/counter.ts", url));
      expect(counter.ok).toBe(true);
      expect(await counter.text()).toContain("Count is");
      for (const path of [
        "src/assets/hero.png",
        "src/assets/vite.svg",
        "src/assets/typescript.svg",
        "favicon.svg",
        "icons.svg",
      ])
        expect((await fetch(new URL(path, url))).ok).toBe(true);
    }
    const cssRequest = { headers: { Accept: "text/css" } };
    expect((await fetch(new URL(`src/${cssName}`, url), cssRequest)).ok).toBe(true);
    const viteClient = await (await fetch(new URL("@vite/client", url))).text();
    const token = viteClient.match(/const wsToken = "([^"]+)"/)?.[1];
    if (!token) throw new Error("Missing Vite WebSocket token.");
    socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, "vite-hmr");
    const messages: { type: string; updates?: { type: string; path: string }[] }[] = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    async function waitFor(check: () => boolean) {
      const deadline = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for Vite HMR: ${JSON.stringify(messages)}`);
        await Bun.sleep(20);
      }
    }
    await waitFor(() => messages.some((message) => message.type === "connected"));
    await writeFile(cssPath, `${original}\n:root { --bunaway-hmr-check: 1; }\n`);
    await waitFor(() =>
      messages.some((message) =>
        message.updates?.some(
          (update) =>
            update.type === "css-update" &&
            new URL(update.path, url).pathname === `/src/${cssName}`,
        ),
      ),
    );
    expect(await (await fetch(new URL(`src/${cssName}`, url), cssRequest)).text()).toContain(
      "--bunaway-hmr-check",
    );
    expect(await readFile(resolve(project.root, "index.html"), "utf8")).toBe(sourceHtml);
  } finally {
    socket?.close();
    await server.stop();
    await writeFile(cssPath, original);
  }
  await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
}
