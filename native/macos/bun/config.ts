import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type HostContext,
  NativeRegistry,
  type Policy,
  parsePolicy,
  type RuntimeIdentity,
} from "@bunaway/protocol";
import { readAppManifest } from "@bunaway/runtime-bun/app-manifest";
import { verifyDevelopmentLaunch } from "@bunaway/runtime-bun/development";
import {
  readWindowSpecs,
  type WindowSpec,
} from "@bunaway/runtime-bun/window-config";
import pin from "../../../runtime/build-manifests/darwin-aarch64.json";

export type MacosConfig = {
  runtime: RuntimeIdentity;
  backendContext: HostContext;
  policy: Policy;
  windows: WindowSpec[];
  assets: string;
  dataRoot: string;
};

function object(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid package metadata.",
  );
  return value as Record<string, unknown>;
}

/** Preserve the host-owned asset origin's exact port while sharing window and policy validation. */
export function readMacosWindowSpecs(
  declarations: unknown,
  policy: Policy,
  developmentUrl?: string,
): WindowSpec[] {
  let origin = developmentUrl;
  if (!origin) {
    const first: unknown = Array.isArray(declarations)
      ? declarations[0]
      : undefined;
    assert(
      first &&
        typeof first === "object" &&
        "home" in first &&
        typeof first.home === "string",
      "Missing window home.",
    );
    const home = new URL(first.home);
    assert(
      home.protocol === "https:" &&
        home.hostname === "app.bunaway.local" &&
        !home.username &&
        !home.password &&
        !home.hash,
      "Packaged home must use the host-owned app origin.",
    );
    origin = home.origin;
  }
  return readWindowSpecs(declarations, policy, origin);
}

/** Validate package inventory and policy before app code or system UI is initialized. */
export async function verifyMacosPackage(
  directory: string,
  devUrl?: string,
): Promise<MacosConfig> {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(Bun.version, pin.bun.version);
  assert.equal(Bun.revision, pin.bun.sourceRevision);
  const root = await realpath(directory);
  const metadata = object(
    await Bun.file(resolve(root, "manifest.json")).json(),
  );
  const runtime = object(metadata.bun);
  const inventory = object(metadata.assets);
  assert.equal(runtime.version, pin.bun.version);
  assert.equal(runtime.executableSha256, pin.bun.executableSha256);
  assert.equal(runtime.sourceRevision, pin.bun.sourceRevision);
  assert(Object.hasOwn(inventory, "assets/manifest.json"));
  for (const [name, expected] of Object.entries(inventory)) {
    assert(
      typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected),
      "Invalid package asset digest.",
    );
    const path = await realpath(resolve(root, name));
    assert(
      path.startsWith(`${root}/`),
      "Package asset escapes resource directory.",
    );
    const actual = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path).arrayBuffer())
      .digest("hex");
    assert.equal(actual, expected, `Package asset hash mismatch: ${name}`);
  }
  const assets = resolve(root, "assets");
  const appManifest = await readAppManifest(assets);
  const app = appManifest.app;
  assert(
    typeof app.appId === "string" &&
      /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(app.appId),
    "Invalid appId.",
  );
  const policy = parsePolicy(JSON.stringify(appManifest.policy));
  // Reject permissions absent from the installed catalog before importing app code.
  new NativeRegistry(appManifest.plugins, {
    mode: "catalog",
  }).validatePolicy(policy);
  const developmentUrl = verifyDevelopmentLaunch(app.development, devUrl);
  const declarations = app.windows ?? [
    {
      view: app.view,
      home: app.home,
      title: app.title,
      window: app.window,
    },
  ];
  const specs = readMacosWindowSpecs(declarations, policy, developmentUrl);
  assert(process.env.HOME, "HOME is required.");
  return {
    runtime: {
      id: app.appId,
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows: specs,
    assets,
    dataRoot: resolve(
      process.env.HOME,
      "Library/Application Support/bunaway",
      app.appId,
    ),
  };
}
