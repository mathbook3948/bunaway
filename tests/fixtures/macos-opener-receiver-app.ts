import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Objc } from "../../native/macos/bun/objc.ts";

export type ReceiverEvent = {
  kind: string;
  target: string;
  pid: number;
};

/** Run only fixture-owned tools and capture failures before their pipes close. */
export async function fixtureCommand(args: string[]): Promise<void> {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  const logs = (await output).join("\n");
  assert.equal(code, 0, logs);
}

async function waitForExit(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ESRCH") {
        return;
      }
      throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("Opener receiver did not stop before cleanup.");
}

/** Compile and register a disposable receiver for a unique document type. Browser defaults stay unchanged. */
export async function createReceiver(root: string) {
  const app = join(root, "한글 Receiver.app");
  const resources = join(app, "Contents/Resources");
  const executable = join(app, "Contents/MacOS/receiver");
  const eventPath = join(resources, "events.jsonl");
  const id = `tests.bunaway.opener.${crypto.randomUUID()}`;
  const extension = `bw${crypto.randomUUID().replaceAll("-", "")}`;
  const contentType = `${id}.document`;
  const objc = new Objc();
  const services = dlopen(
    "/System/Library/Frameworks/CoreServices.framework/CoreServices",
    {
      LSRegisterURL: {
        args: [
          "u64",
          "bool",
        ],
        returns: "i32",
      },
      LSSetDefaultRoleHandlerForContentType: {
        args: [
          "u64",
          "u32",
          "u64",
        ],
        returns: "i32",
      },
    },
  );
  let registered = false;
  let disposed = false;
  const readEvents = async (): Promise<ReceiverEvent[]> => {
    let lines: string;
    try {
      lines = await readFile(eventPath, "utf8");
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
        return [];
      }
      throw error;
    }
    return lines
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        assert(
          value &&
            typeof value === "object" &&
            "kind" in value &&
            typeof value.kind === "string" &&
            "target" in value &&
            typeof value.target === "string" &&
            "pid" in value &&
            typeof value.pid === "number",
        );
        return {
          kind: value.kind,
          target: value.target,
          pid: value.pid,
        };
      });
  };
  const waitFor = async (predicate: (event: ReceiverEvent) => boolean) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const event = (await readEvents()).find(predicate);
      if (event) {
        return event;
      }
      await Bun.sleep(25);
    }
    throw new Error(
      `Receiver did not receive request: ${JSON.stringify(await readEvents())}`,
    );
  };
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    const errors: unknown[] = [];
    const clean = async (work: () => void | Promise<void>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    // Attempt every independent release even if receiver shutdown fails.
    await clean(async () => {
      const ready = (await readEvents()).find(
        (event) => event.kind === "ready",
      );
      if (ready) {
        await writeFile(join(resources, "stop"), "stop");
        await waitForExit(ready.pid);
      }
    });
    await clean(async () => {
      if (registered) {
        await fixtureCommand([
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
          "-u",
          app,
        ]);
      }
    });
    await clean(() => services.close());
    await clean(() =>
      rm(app, {
        recursive: true,
        force: true,
      }),
    );
    if (errors.length) {
      throw new AggregateError(errors, "Receiver cleanup failed.");
    }
  };
  try {
    await mkdir(resources, {
      recursive: true,
    });
    await mkdir(join(app, "Contents/MacOS"), {
      recursive: true,
    });
    await writeFile(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleName</key><string>Bunaway Opener Fixture</string>
<key>CFBundleExecutable</key><string>receiver</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>UTExportedTypeDeclarations</key><array><dict><key>UTTypeIdentifier</key><string>${contentType}</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><string>${extension}</string></dict></dict></array>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>${contentType}</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>Owner</string><key>LSItemContentTypes</key><array><string>${contentType}</string></array></dict></array>
</dict></plist>`,
    );
    await fixtureCommand([
      process.execPath,
      "build",
      "--compile",
      fileURLToPath(new URL("./macos-opener-receiver.ts", import.meta.url)),
      "--outfile",
      executable,
    ]);
    await fixtureCommand([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve("native/macos/bun/entitlements.plist"),
      app,
    ]);
    await fixtureCommand([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      app,
    ]);
    objc.withAutoreleasePool(() => {
      const appUrl = objc.send(
        objc.class("NSURL"),
        "fileURLWithPath:",
        objc.string(app),
      );
      assert(appUrl);
      assert.equal(services.symbols.LSRegisterURL(BigInt(appUrl), true), 0);
      registered = true;
    });
    await fixtureCommand([
      "/usr/bin/open",
      "-g",
      "-n",
      app,
    ]);
    await waitFor((event) => event.kind === "ready");
    objc.withAutoreleasePool(() => {
      const status = services.symbols.LSSetDefaultRoleHandlerForContentType(
        BigInt(objc.string(contentType)),
        0xffffffff,
        BigInt(objc.string(id)),
      );
      console.info("Unique fixture document association status:", status);
      assert.equal(status, 0, "Unique fixture document association");
    });
    const sample = join(root, `한글 값,".${extension}`);
    await writeFile(sample, "controlled file fixture");
    objc.withAutoreleasePool(() => {
      const workspace = objc.send(objc.class("NSWorkspace"), "sharedWorkspace");
      const url = objc.send(
        objc.class("NSURL"),
        "fileURLWithPath:",
        objc.string(sample),
      );
      const handler = objc.send(workspace, "URLForApplicationToOpenURL:", url);
      const handlerPath = objc.text(objc.send(handler, "path"));
      console.info("Controlled file handler:", handlerPath);
      assert.equal(
        handlerPath,
        app,
        "Controlled file handler must resolve to the receiver.",
      );
    });
    return {
      app,
      sample,
      readEvents,
      waitFor,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
