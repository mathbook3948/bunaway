import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BunawayError,
  type HostContext,
  parsePolicy,
  type Policy,
  type RuntimeIdentity,
} from "../../../packages/protocol/src/index.ts";
import { readAppManifest } from "../../../packages/runtime-bun/src/app-manifest.ts";
import { verifyDevelopmentLaunch } from "../../../packages/runtime-bun/src/development.ts";
import {
  readWindowSpecs,
  type WindowSpec,
} from "../../../packages/runtime-bun/src/window-config.ts";
import pin from "../../../runtime/build-manifests/darwin-aarch64.json";

export type MacosConfig = {
  runtime: RuntimeIdentity;
  backendContext: HostContext;
  policy: Policy;
  window: WindowSpec;
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
  if (
    policy.backend.permissions.length ||
    policy.views.some((view) => view.host.permissions.length)
  ) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "macOS native plugin adapters are not implemented.",
    });
  }
  const developmentUrl = verifyDevelopmentLaunch(app.development, devUrl);
  const declarations = app.windows ?? [
    {
      view: app.view,
      home: app.home,
      title: app.title,
      window: app.window,
    },
  ];
  assert(Array.isArray(declarations) && declarations.length === 1);
  const declared: unknown = declarations[0];
  assert(
    declared &&
      typeof declared === "object" &&
      "home" in declared &&
      typeof declared.home === "string",
  );
  const home = new URL(declared.home);
  if (!developmentUrl) {
    assert(
      home.protocol === "https:" &&
        home.hostname === "app.bunaway.local" &&
        !home.username &&
        !home.password &&
        !home.hash,
      "Packaged home must use the host-owned app origin.",
    );
  }
  // Preserve the exact-port asset contract while sharing dimension/policy checks.
  const specs = readWindowSpecs(
    declarations,
    policy,
    developmentUrl ?? home.origin,
  );
  assert(
    specs.length === 1 && specs[0],
    "macOS currently supports one window.",
  );
  assert(process.env.HOME, "HOME is required.");
  return {
    runtime: {
      id: app.appId,
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    window: specs[0],
    assets,
    dataRoot: resolve(
      process.env.HOME,
      "Library/Application Support/bunaway",
      app.appId,
    ),
  };
}
