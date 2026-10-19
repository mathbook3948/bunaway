import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { frameworkRoot } from "#cli/files";

// The Android WebView itself runs only in the device suite (`mise run host:android`).
// These checks pin the contract that suite relies on, so a regression fails in every CI job.
const rendererPath = resolve(
  frameworkRoot,
  "native/android/host/src/main/java/dev/bunaway/host/Renderer.java",
);

test("the Android asset handler maps .wasm to application/wasm", async () => {
  const source = await Bun.file(rendererPath).text();
  const body =
    /private static String mimeOf\(String path\) \{([\s\S]*?)\n {4}\}\n/.exec(
      source,
    )?.[1];
  expect(body).toBeDefined();
  // instantiateStreaming rejects any other Content-Type, so the case must return exactly this.
  expect(body).toMatch(
    /case "wasm":(?:\s*\/\/[^\n]*)*\s*return "application\/wasm";/,
  );
});

test("the device suite packages a valid .wasm and instantiates it by streaming", async () => {
  const wasm = new Uint8Array(
    await Bun.file(
      resolve(frameworkRoot, "tests/fixtures/android/web/add.wasm"),
    ).arrayBuffer(),
  );
  expect(WebAssembly.validate(wasm)).toBe(true);
  const run = await Bun.file(
    resolve(frameworkRoot, "native/android/run.ts"),
  ).text();
  expect(run).toContain('"add.wasm"');
  const client = await Bun.file(
    resolve(frameworkRoot, "tests/fixtures/android/web/client.ts"),
  ).text();
  expect(client).toContain("WebAssembly.instantiateStreaming");
  expect(client).toContain('"application/wasm"');
});

test("the host CSP allows WebAssembly compilation but not eval", async () => {
  const source = await Bun.file(rendererPath).text();
  // Take only the literals of the argument that follows the header name; they are concatenated.
  expect(source.split('"Content-Security-Policy"').length - 1).toBe(1);
  const argument = /"Content-Security-Policy",([\s\S]*?)\);/.exec(source)?.[1];
  expect(argument).toBeDefined();
  const csp = [
    ...(argument ?? "").matchAll(/"([^"]*)"/g),
  ]
    .map((match) => match[1])
    .join("");
  expect(csp).toBe(
    [
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self'",
      "font-src 'self'",
      "connect-src 'self' ws://127.0.0.1:*",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  );
});
