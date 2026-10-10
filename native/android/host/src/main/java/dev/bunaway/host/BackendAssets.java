package dev.bunaway.host;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Iterator;
import java.util.stream.Stream;

/** Owns the extracted backend tree, which contains APK inputs rather than app data. */
final class BackendAssets {
    /** APK asset access; a directory lists its children, while a file opens as a stream. */
    interface Source {
        String[] list(String path) throws IOException;

        InputStream open(String path) throws IOException;
    }

    /**
     * Replaces the previous backend and configuration before Bun starts. Never follows links in the
     * previous tree, and leaves other no-backup files untouched. A failed extraction prevents
     * startup; the next attempt discards the partial tree before trying again.
     */
    static File prepare(File noBackupDirectory, Source source) throws IOException {
        Path directory = new File(noBackupDirectory, "bunaway-runtime").toPath();
        if (Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            // Delete children before their parent; Files.walk does not follow symbolic links.
            try (Stream<Path> paths = Files.walk(directory)) {
                Iterator<Path> entries = paths.sorted(Comparator.reverseOrder()).iterator();
                while (entries.hasNext()) Files.delete(entries.next());
            }
        }
        Files.createDirectories(directory);
        copyTree(source, "bunaway/backend", directory);
        for (String name : new String[] {"bunfig.toml", "tsconfig.json"}) {
            copyFile(source, "bunaway/" + name, directory.resolve(name));
        }
        return directory.toFile();
    }

    /** Preserves the relative paths of the backend entry and its file imports. */
    private static void copyTree(Source source, String path, Path destination) throws IOException {
        String[] names = source.list(path);
        if (names == null || names.length == 0) {
            copyFile(source, path, destination);
            return;
        }
        Files.createDirectories(destination);
        for (String name : names) {
            copyTree(source, path + "/" + name, destination.resolve(name));
        }
    }

    private static void copyFile(Source source, String path, Path destination) throws IOException {
        try (InputStream input = source.open(path)) {
            Files.copy(input, destination);
        }
    }

    private BackendAssets() {}
}
