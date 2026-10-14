import { expect, test } from "bun:test";
import { appearanceOperations } from "#plugins/appearance/src/operations";
import { nativeFactory } from "../fixtures/native-platform.ts";

test.skipIf(process.platform !== "darwin")(
  "packaged appearance adapter loads AppKit in a fresh process and owns its framework lifetime",
  async () => {
    const entry = Bun.resolveSync(
      "@bunaway/plugin-appearance/native/macos",
      import.meta.dir,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { default: appearance } = await import(${JSON.stringify(entry)});
const first = appearance._definition.nativePlatforms.macos.create({dataRoot:".",capabilities:[]});
const second = appearance._definition.nativePlatforms.macos.create({dataRoot:".",capabilities:[]});
try {
  await first.dispose();
  await first.dispose();
  const result = await second.execute("appearance.getPreferences", null, "backend");
  console.log(JSON.stringify(result));
} finally {
  await first.dispose();
  await second.dispose();
}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, errors).toBe(0);
    const snapshot = appearanceOperations.getPreferences.output.parse(
      JSON.parse(output),
    );
    expect(snapshot.appsTheme).not.toBeNull();
    expect(snapshot.systemTheme).toBeNull();
    expect(snapshot.forcedColors).toBe(false);
  },
  30_000,
);

test.skipIf(process.platform !== "darwin")(
  "real AppKit preferences, sRGB colors, appearance restoration and independent adapter lifetimes",
  async () => {
    const [{ default: nativeDefinition }, { Objc }, { dlopen, linkSymbols }] =
      await Promise.all([
        import("#plugins/appearance/src/index"),
        import("#native/macos/bun/objc"),
        import("bun:ffi"),
      ]);
    const createOperations = nativeFactory(nativeDefinition, "macos");
    const objc = new Objc();
    const runtime = dlopen("/usr/lib/libobjc.A.dylib", {
      objc_msgSend: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "ptr",
      },
    } as const);
    const address: unknown = Reflect.get(runtime.symbols.objc_msgSend, "ptr");
    if (
      typeof address !== "number" ||
      !Number.isSafeInteger(address) ||
      address <= 0
    ) {
      throw new Error("Objective-C driver is unavailable.");
    }
    const driver = linkSymbols({
      component: {
        // Bun's linked callable has a native ptr that is absent from its typings.
        ptr: address as import("bun:ffi").Pointer,
        args: [
          "ptr",
          "ptr",
        ],
        returns: "f64",
      },
      drawing: {
        ptr: address as import("bun:ffi").Pointer,
        args: [
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "void",
      },
    } as const);
    const first = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    const second = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    const read = async () =>
      appearanceOperations.getPreferences.output.parse(
        await second.execute("appearance.getPreferences", null, "backend"),
      );
    try {
      await first.dispose();
      await first.dispose();
      await expect(
        first.execute("appearance.getPreferences", null, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
      await expect(
        second.execute("appearance.unknown", null, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
      await expect(
        second.execute("appearance.getPreferences", {}, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      objc.withAutoreleasePool(async () => {
        const app = objc.send(objc.class("NSApplication"), "sharedApplication");
        const original = objc.send(app, "appearance");
        const appearanceClass = objc.class("NSAppearance");
        const previousDrawing = objc.send(
          appearanceClass,
          "currentDrawingAppearance",
        );
        const workspace = objc.send(
          objc.class("NSWorkspace"),
          "sharedWorkspace",
        );
        try {
          for (const [name, expected] of [
            [
              "NSAppearanceNameAqua",
              "light",
            ],
            [
              "NSAppearanceNameDarkAqua",
              "dark",
            ],
            [
              "NSAppearanceNameAccessibilityHighContrastAqua",
              "light",
            ],
            [
              "NSAppearanceNameAccessibilityHighContrastDarkAqua",
              "dark",
            ],
          ] as const) {
            const appearance = objc.send(
              appearanceClass,
              "appearanceNamed:",
              objc.string(name),
            );
            expect(appearance).not.toBeNull();
            // Only this test process's app appearance changes. User settings stay untouched.
            objc.send(app, "setAppearance:", appearance);
            expect(objc.send(app, "appearance")).toBe(appearance);
            const effectiveAppearance = objc.send(app, "effectiveAppearance");
            expect(effectiveAppearance).not.toBeNull();
            const themeNames = objc.send(
              objc.send(
                objc.class("NSArray"),
                "arrayWithObject:",
                objc.string("NSAppearanceNameAqua"),
              ),
              "arrayByAddingObject:",
              objc.string("NSAppearanceNameDarkAqua"),
            );
            const nativeMatch = objc.text(
              objc.send(
                effectiveAppearance,
                "bestMatchFromAppearancesWithNames:",
                themeNames,
              ),
            );
            const snapshot = await read();
            console.log(
              `AppKit appearance: requested=${name}, effective=${objc.text(objc.send(effectiveAppearance, "name"))}, nativeMatch=${nativeMatch}, adapterTheme=${snapshot.appsTheme}`,
            );
            expect(nativeMatch, name).toMatch(/^NSAppearanceName(Dark)?Aqua$/);
            const nativeTheme =
              nativeMatch === "NSAppearanceNameDarkAqua" ? "dark" : "light";
            // AppKit can best-match an explicit contrast override to Aqua, even
            // when its name contains DarkAqua. Compare the actual native query.
            expect(snapshot.appsTheme, name).toBe(nativeTheme);
            if (
              name === "NSAppearanceNameAqua" ||
              name === "NSAppearanceNameDarkAqua"
            ) {
              expect(snapshot.appsTheme, name).toBe(expected);
            }
            expect(snapshot.systemTheme).toBeNull();
            expect(snapshot.forcedColors).toBe(false);
            expect(snapshot.highContrast).toBe(
              Boolean(
                objc.send(
                  workspace,
                  "accessibilityDisplayShouldIncreaseContrast",
                ),
              ),
            );
            expect(snapshot.reducedMotion).toBe(
              Boolean(
                objc.send(workspace, "accessibilityDisplayShouldReduceMotion"),
              ),
            );
            expect(snapshot.transparencyEnabled).toBe(
              !objc.send(
                workspace,
                "accessibilityDisplayShouldReduceTransparency",
              ),
            );
            expect(snapshot.screenReaderEnabled).toBe(
              Boolean(objc.send(workspace, "isVoiceOverEnabled")),
            );
            expect(objc.send(appearanceClass, "currentDrawingAppearance")).toBe(
              previousDrawing,
            );
            // AppKit determines the effective appearance from the override and OS
            // accessibility settings. Compare that public contract source, rather
            // than assuming an override is also the effective drawing appearance.
            // Keep this host binding independent of the plugin binding.
            const colors = [
              [
                "controlAccentColor",
                snapshot.accentColor,
              ],
              [
                "windowBackgroundColor",
                snapshot.colors.window,
              ],
              [
                "textColor",
                snapshot.colors.windowText,
              ],
              [
                "selectedTextBackgroundColor",
                snapshot.colors.highlight,
              ],
              [
                "selectedTextColor",
                snapshot.colors.highlightText,
              ],
            ] as const;
            const nativeColors: string[] = [];
            let drawingAppearance:
              | import("#native/macos/bun/objc").ObjcObject
              | null = null;
            let oracleFailed = false;
            let oracleError: unknown;
            const oracle = objc.block(0, () => {
              try {
                drawingAppearance = objc.send(
                  appearanceClass,
                  "currentDrawingAppearance",
                );
                for (const [selector] of colors) {
                  const native = objc.send(objc.class("NSColor"), selector);
                  const rgb = objc.send(
                    native,
                    "colorUsingColorSpace:",
                    objc.send(objc.class("NSColorSpace"), "sRGBColorSpace"),
                  );
                  const components = [
                    "redComponent",
                    "greenComponent",
                    "blueComponent",
                  ].map((component) => {
                    // Objc objects may be tagged; only this FFI argument boundary needs the assertion.
                    const value = driver.symbols.component(
                      rgb as import("bun:ffi").Pointer,
                      objc.selector(component) as import("bun:ffi").Pointer,
                    );
                    return Math.round(Math.max(0, Math.min(1, value)) * 255)
                      .toString(16)
                      .padStart(2, "0");
                  });
                  nativeColors.push(`#${components.join("")}`);
                }
              } catch (error) {
                // Assertions and JS failures must never unwind through AppKit.
                oracleFailed = true;
                oracleError = error;
              }
            });
            driver.symbols.drawing(
              effectiveAppearance as import("bun:ffi").Pointer,
              objc.selector(
                "performAsCurrentDrawingAppearance:",
              ) as import("bun:ffi").Pointer,
              oracle,
            );
            if (oracleFailed) {
              throw oracleError;
            }
            expect<import("#native/macos/bun/objc").ObjcObject | null>(
              drawingAppearance,
              name,
            ).toBe(effectiveAppearance);
            expect(nativeColors, name).toHaveLength(5);
            for (const [index, [selector, actual]] of colors.entries()) {
              expect<string | undefined>(actual, `${name}: ${selector}`).toBe(
                nativeColors[index],
              );
            }
            expect(objc.send(appearanceClass, "currentDrawingAppearance")).toBe(
              previousDrawing,
            );
          }
          // Keep the lifetime stress check on a real dark appearance, independently
          // of how this OS resolves the artificial contrast overrides above.
          objc.send(
            app,
            "setAppearance:",
            objc.send(
              appearanceClass,
              "appearanceNamed:",
              objc.string("NSAppearanceNameDarkAqua"),
            ),
          );
          expect((await read()).appsTheme).toBe("dark");
          Bun.gc(true);
          const initialMemory = process.memoryUsage().rss;
          for (let iteration = 0; iteration < 20; iteration++) {
            const adapter = createOperations({
              dataRoot: ".",
              capabilities: [],
            });
            try {
              for (let readIndex = 0; readIndex < 50; readIndex++) {
                appearanceOperations.getPreferences.output.parse(
                  await adapter.execute(
                    "appearance.getPreferences",
                    null,
                    "backend",
                  ),
                );
              }
            } finally {
              void (await adapter.dispose());
            }
          }
          Bun.gc(true);
          // Allow allocator and framework caches while bounding retained Cocoa objects
          // and callback trampolines across 1,000 reads and 20 adapter lifetimes.
          expect(process.memoryUsage().rss - initialMemory).toBeLessThan(
            64 * 1024 * 1024,
          );
          expect((await read()).appsTheme).toBe("dark");
          expect(objc.send(appearanceClass, "currentDrawingAppearance")).toBe(
            previousDrawing,
          );
        } finally {
          objc.send(app, "setAppearance:", original);
          objc.send(appearanceClass, "setCurrentAppearance:", previousDrawing);
        }
      });
    } finally {
      await first.dispose();
      await second.dispose();
      objc.releaseCallbacks();
      driver.close();
      runtime.close();
    }
  },
  30_000,
);
