import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { JsonValue } from "@bunaway/protocol";
import { Objc } from "../../native/macos/bun/objc.ts";

type Event = {
  kind: string;
  target: string;
  pid: number;
};
const isolated =
  process.platform === "darwin" && process.env.BUNAWAY_OPENER_ISOLATED === "1";

async function command(args: string[]) {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(
      `Fixture command failed (${code}): ${(await output).join("\n")}`,
    );
  }
  await output;
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
  throw new Error("Opener receiver did not stop before fixture cleanup.");
}

test.skipIf(!isolated)(
  "real I/O Worker NSWorkspace delivers controlled files and HTTP/HTTPS URLs to a signed fixture app",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-opener-native-")),
    );
    const app = join(root, "한글 Receiver.app");
    const resources = join(app, "Contents/Resources");
    const executable = join(app, "Contents/MacOS/receiver");
    const eventPath = join(resources, "events.jsonl");
    const id = `tests.bunaway.opener.fixture.${crypto.randomUUID()}`;
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
        LSCopyDefaultHandlerForURLScheme: {
          args: [
            "u64",
          ],
          returns: "u64",
        },
        LSSetDefaultHandlerForURLScheme: {
          args: [
            "u64",
            "u64",
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
    const foundation = dlopen(
      "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
      {
        CFRelease: {
          args: [
            "u64",
          ],
          returns: "void",
        },
      },
    );
    const schemes = [
      "http",
      "https",
    ];
    const originals = new Map<string, string>();
    let worker: Worker | undefined;
    let registered = false;
    let events: Event[] = [];
    const readEvents = async () => {
      try {
        events = (await readFile(eventPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if (
          !(error instanceof Error && Reflect.get(error, "code") === "ENOENT")
        ) {
          throw error;
        }
      }
      return events;
    };
    const waitFor = async (predicate: (event: Event) => boolean) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const event = (await readEvents()).find(predicate);
        if (event) {
          return event;
        }
        await Bun.sleep(25);
      }
      throw new Error(
        `Fixture did not receive the request: ${JSON.stringify(events)}`,
      );
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
<key>LSUIElement</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>http</string><string>https</string></array></dict></array>
<key>UTExportedTypeDeclarations</key><array><dict><key>UTTypeIdentifier</key><string>${contentType}</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><string>${extension}</string></dict></dict></array>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>Owner</string><key>LSItemContentTypes</key><array><string>${contentType}</string></array></dict></array>
</dict></plist>`,
      );
      await command([
        process.execPath,
        "build",
        "--compile",
        fileURLToPath(
          new URL("../fixtures/macos-opener-receiver.ts", import.meta.url),
        ),
        "--outfile",
        executable,
      ]);
      await command([
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--entitlements",
        resolve("native/macos/bun/entitlements.plist"),
        app,
      ]);
      await command([
        "/usr/bin/codesign",
        "--verify",
        "--strict",
        app,
      ]);
      objc.withAutoreleasePool(() => {
        for (const scheme of schemes) {
          const handler = services.symbols.LSCopyDefaultHandlerForURLScheme(
            BigInt(objc.string(scheme)),
          );
          expect(handler).not.toBe(0n);
          try {
            originals.set(scheme, objc.text(handler));
          } finally {
            foundation.symbols.CFRelease(handler);
          }
        }
        const appUrl = objc.send(
          objc.class("NSURL"),
          "fileURLWithPath:",
          objc.string(app),
        );
        expect(appUrl).not.toBeNull();
        expect(services.symbols.LSRegisterURL(BigInt(appUrl ?? 0), true)).toBe(
          0,
        );
        registered = true;
        expect(
          services.symbols.LSSetDefaultRoleHandlerForContentType(
            BigInt(objc.string(contentType)),
            0xffffffff,
            BigInt(objc.string(id)),
          ),
        ).toBe(0);
        for (const scheme of schemes) {
          expect(
            services.symbols.LSSetDefaultHandlerForURLScheme(
              BigInt(objc.string(scheme)),
              BigInt(objc.string(id)),
            ),
          ).toBe(0);
          const handler = services.symbols.LSCopyDefaultHandlerForURLScheme(
            BigInt(objc.string(scheme)),
          );
          try {
            expect(objc.text(handler)).toBe(id);
          } finally {
            foundation.symbols.CFRelease(handler);
          }
        }
      });
      await command([
        "/usr/bin/open",
        "-g",
        "-n",
        app,
      ]);
      const receiver = await waitFor((event) => event.kind === "ready");
      expect(receiver.pid).toBeGreaterThan(0);
      const sample = join(root, `한글 값,".${extension}`);
      await writeFile(sample, "controlled file fixture");
      worker = new Worker(
        new URL("../fixtures/macos-opener-worker.ts", import.meta.url),
      );
      let nextId = 0;
      const request = (
        operation: string,
        payload: JsonValue,
        permissions = [
          operation,
        ],
        cancelled = false,
      ) =>
        new Promise<{
          id: number;
          result?: null;
          error?: string;
        }>((resolveRequest, reject) => {
          const requestId = ++nextId;
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Native fixture dispatch timed out."));
          }, 15000);
          const receive = (reply: {
            id: number;
            result?: null;
            error?: string;
          }) => {
            if (reply.id === requestId) {
              cleanup();
              resolveRequest(reply);
            }
          };
          const cleanup = () => {
            clearTimeout(timer);
            worker?.off("message", receive);
            worker?.off("error", rejectWorker);
          };
          const rejectWorker = (error: Error) => {
            cleanup();
            reject(error);
          };
          worker?.on("message", receive);
          worker?.once("error", rejectWorker);
          worker?.postMessage({
            id: requestId,
            operation,
            payload,
            permissions,
            cancelled,
          });
        });
      expect(
        await request(
          "opener.openFile",
          {
            path: sample,
          },
          [],
        ),
      ).toEqual({
        id: 1,
        error: "PERMISSION_DENIED",
      });
      expect(
        await request(
          "opener.openUrl",
          {
            url: "http://127.0.0.1/cancelled",
          },
          [
            "opener.openUrl",
          ],
          true,
        ),
      ).toMatchObject({
        error: "CANCELLED",
      });
      expect(
        await request("opener.openFile", {
          path: sample,
        }),
      ).toMatchObject({
        result: null,
      });
      await waitFor(
        (event) =>
          (event.kind === "file" && event.target === sample) ||
          (event.kind === "url" &&
            event.target.startsWith("file:") &&
            fileURLToPath(event.target) === sample),
      );
      for (const scheme of schemes) {
        const url = new URL(
          `${scheme}://127.0.0.1:43210/한글 값?q=one&second=two#quote"`,
        ).href;
        expect(
          await request("opener.openUrl", {
            url,
          }),
        ).toMatchObject({
          result: null,
        });
        await waitFor((event) => event.kind === "url" && event.target === url);
      }
      expect(
        await request(
          "opener.revealFile",
          {
            path: sample,
          },
          [
            "opener.openFile",
          ],
        ),
      ).toMatchObject({
        error: "PERMISSION_DENIED",
      });
      expect(
        await request("opener.revealFile", {
          path: sample,
        }),
      ).toMatchObject({
        result: null,
      });
      expect(
        await request("opener.openFileWith", {
          path: sample,
          app: "C:/app.exe",
        }),
      ).toMatchObject({
        error: "UNSUPPORTED",
      });
      expect(await request("dispose", null)).toMatchObject({
        result: null,
      });
      expect(
        (await readEvents()).some((event) =>
          event.target.includes("/cancelled"),
        ),
      ).toBe(false);
      await mkdir("build", {
        recursive: true,
      });
      await writeFile(
        "build/macos-opener-results.json",
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            bun: Bun.version,
            revision: Bun.revision,
            execution: "isolated I/O Worker fixture",
            events,
            reveal:
              "NSWorkspace request acceptance; selection UI not inspected",
            hostIntegration:
              "pending shared macOS I/O dispatch and registration",
          },
          null,
          2,
        ),
      );
    } finally {
      await worker?.terminate();
      // Restore the disposable runner's defaults before stopping or deleting its receiver.
      try {
        objc.withAutoreleasePool(() => {
          for (const [scheme, handler] of originals) {
            expect(
              services.symbols.LSSetDefaultHandlerForURLScheme(
                BigInt(objc.string(scheme)),
                BigInt(objc.string(handler)),
              ),
            ).toBe(0);
          }
        });
      } finally {
        try {
          if (events.some((event) => event.kind === "ready")) {
            await writeFile(join(resources, "stop"), "stop");
            const pid = events.find((event) => event.kind === "ready")?.pid;
            if (pid) {
              await waitForExit(pid);
            }
          }
          if (registered) {
            await command([
              "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
              "-u",
              app,
            ]);
          }
        } finally {
          services.close();
          foundation.close();
          await rm(root, {
            recursive: true,
            force: true,
          });
        }
      }
    }
  },
  120000,
);
