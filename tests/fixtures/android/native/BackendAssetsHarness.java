package dev.bunaway.host;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/** Exercises the actual backend extraction owner with filesystem-backed APK asset inputs. */
public final class BackendAssetsHarness {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static BackendAssets.Source source(Path assets) {
        return new BackendAssets.Source() {
            @Override
            public String[] list(String path) {
                String[] names = assets.resolve(path).toFile().list();
                return names == null ? new String[0] : names;
            }

            @Override
            public InputStream open(String path) throws IOException {
                return Files.newInputStream(assets.resolve(path));
            }
        };
    }

    private static void write(Path path, String text) throws IOException {
        Files.createDirectories(path.getParent());
        Files.writeString(path, text);
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        Path assets = root.resolve("apk");
        Path noBackup = root.resolve("no-backup");
        Path runtime = noBackup.resolve("bunaway-runtime");
        Path appData = noBackup.resolve("app-data/keep.txt");
        Path imports = assets.resolve("bunaway/backend/backend-assets");
        write(assets.resolve("bunaway/backend/backend.js"), "first backend");
        write(assets.resolve("bunaway/bunfig.toml"), "env = false");
        write(assets.resolve("bunaway/tsconfig.json"), "{}");
        write(imports.resolve("data-old.txt"), "old import");
        write(appData, "app data");
        require(
                BackendAssets.prepare(noBackup.toFile(), source(assets)).toPath().equals(runtime),
                "Wrong backend directory");
        require(
                Files.readString(runtime.resolve("backend-assets/data-old.txt"))
                        .equals("old import"),
                "First APK import was not extracted");

        // Updating the APK replaces the old hash rather than accumulating both versions.
        Files.delete(imports.resolve("data-old.txt"));
        write(imports.resolve("data-new.txt"), "새 import 😀");
        write(assets.resolve("bunaway/backend/backend.js"), "second backend");
        write(runtime.resolve("removed/nested/import.bin"), "obsolete asset");
        BackendAssets.prepare(noBackup.toFile(), source(assets));
        require(!Files.exists(runtime.resolve("backend-assets/data-old.txt")), "Old hash survived");
        require(!Files.exists(runtime.resolve("removed")), "Removed directory survived");
        require(
                Files.readString(runtime.resolve("backend.js")).equals("second backend"),
                "Backend entry was not replaced");
        require(
                Files.readString(runtime.resolve("backend-assets/data-new.txt"))
                        .equals("새 import 😀"),
                "New APK import changed");
        require(
                Files.readString(runtime.resolve("bunfig.toml")).equals("env = false"),
                "Bun configuration was not extracted");
        require(
                Files.readString(runtime.resolve("tsconfig.json")).equals("{}"),
                "TypeScript configuration was not extracted");
        require(Files.readString(appData).equals("app data"), "App data was removed");

        // A failed copy cannot start Bun; a retry must remove its partial extraction too.
        Files.delete(assets.resolve("bunaway/tsconfig.json"));
        try {
            BackendAssets.prepare(noBackup.toFile(), source(assets));
            throw new AssertionError("Missing APK input was accepted");
        } catch (IOException expected) {
            write(runtime.resolve("partial-leftover.txt"), "partial extraction");
        }
        write(assets.resolve("bunaway/tsconfig.json"), "{}");
        BackendAssets.prepare(noBackup.toFile(), source(assets));
        require(
                !Files.exists(runtime.resolve("partial-leftover.txt")),
                "Partial tree survived retry");
        require(Files.readString(appData).equals("app data"), "Failed extraction removed app data");

        // Windows requires extra privileges for symlinks. Linux and macOS check both boundaries.
        if (java.io.File.separatorChar != '\\') {
            Path outside = root.resolve("outside");
            write(outside.resolve("keep.txt"), "outside data");
            Files.createSymbolicLink(runtime.resolve("linked-assets"), outside);
            BackendAssets.prepare(noBackup.toFile(), source(assets));
            require(
                    Files.readString(outside.resolve("keep.txt")).equals("outside data"),
                    "Nested link cleanup followed the target");
            Path oldRuntime = noBackup.resolve("old-runtime");
            Files.move(runtime, oldRuntime);
            Files.createSymbolicLink(runtime, outside);
            BackendAssets.prepare(noBackup.toFile(), source(assets));
            require(!Files.isSymbolicLink(runtime), "Runtime root remained a link");
            require(
                    Files.readString(outside.resolve("keep.txt")).equals("outside data"),
                    "Runtime root cleanup followed the target");
        }
        System.out.println(
                "PASS: APK replacement, removed imports, app data preservation and failed"
                        + " extraction retry");
    }
}
