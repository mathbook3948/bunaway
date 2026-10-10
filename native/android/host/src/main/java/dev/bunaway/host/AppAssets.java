package dev.bunaway.host;

import static dev.bunaway.host.Protocol.*;

import android.content.Context;
import android.net.Uri;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Immutable APK inputs and origin policy shared by the process and renderer owners.
 *
 * <p>The CLI writes these files under {@code assets/bunaway/}. They are validated again here
 * because the APK is the trust boundary for the installed host.
 */
final class AppAssets {
    /** Application context used for asset and private file access; never an Activity. */
    final Context context;

    /** Validator for Java and Bun pipe frames. */
    final Protocol processProtocol;

    /** Validator for messages exchanged with the WebView client SDK. */
    final Protocol webProtocol;

    final JsonObject policy;

    /** Policy view ID served by the single Android WebView. */
    final String view;

    /** Initial packaged URL loaded into the WebView. */
    final String home;

    /** Normalized origin of {@link #home}; the only origin given bridge access. */
    final String origin;

    final String title;

    /** Bun version the backend must report in its ready frame. */
    final String bunVersion;

    /**
     * Loads the generated schemas and app configuration, then rejects settings the Android host
     * cannot enforce.
     *
     * @throws IOException when a packaged input is missing or unreadable
     * @throws IllegalArgumentException when the configuration violates the schema, selects a
     *     missing or duplicate view, uses a non-HTTPS or disallowed home origin, or requests native
     *     permissions that Android does not implement yet
     */
    AppAssets(Context context) throws IOException {
        this.context = context;
        processProtocol = protocol("process");
        webProtocol = protocol("message");
        JsonObject config = readObject(read("host.json"));
        policy = protocol("policy").parse(config.get("policy").toString());
        view = text(config, "view");
        home = text(config, "home");
        origin = originOf(Uri.parse(home));
        title = text(config, "title");
        bunVersion = text(config, "bunVersion");

        // Select the configured view while rejecting permissions anywhere in the policy.
        Set<String> ids = new HashSet<>();
        JsonObject selected = null;
        for (JsonElement item : policy.getAsJsonArray("views")) {
            JsonObject candidate = item.getAsJsonObject();
            String id = text(candidate, "id");
            require(ids.add(id), "Duplicate policy view");
            if (id.equals(view)) selected = candidate;
            require(
                    candidate.getAsJsonObject("host").getAsJsonArray("permissions").isEmpty(),
                    "Android native permissions are not implemented");
        }
        require(selected != null, "Missing policy view");

        // The bridge is registered for the home origin only, so it must be a policy origin.
        boolean allowed = false;
        for (JsonElement item : selected.getAsJsonArray("origins")) {
            if (origin.equals(item.getAsString())) allowed = true;
        }
        require(allowed, "Home origin not allowed");
        require(
                "https".equals(Uri.parse(home).getScheme()),
                "Android requires packaged HTTPS assets");
        require(
                policy.getAsJsonObject("backend").getAsJsonArray("permissions").isEmpty(),
                "Android native permissions are not implemented");
    }

    /**
     * Reads a UTF-8 text file from {@code assets/bunaway/}.
     *
     * @throws IOException when the asset is missing or unreadable
     */
    String read(String name) throws IOException {
        try (InputStream input = context.getAssets().open("bunaway/" + name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            copy(input, output);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private Protocol protocol(String name) throws IOException {
        return new Protocol(readObject(read(name + ".schema.json")));
    }

    /**
     * Copies the backend bundle and its Bun configuration into the app's private no-backup
     * directory and returns that directory.
     *
     * <p>Bun needs real file paths, while APK assets are only streams. Each start overwrites these
     * framework files so an app update replaces the code. Other files in the app's data directories
     * are left untouched.
     *
     * @throws IOException when the directory cannot be created or a file cannot be copied
     */
    File prepareBackend() throws IOException {
        File directory = new File(context.getNoBackupFilesDir(), "bunaway-runtime");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Cannot create backend directory");
        }
        for (String name : new String[] {"backend.js", "bunfig.toml", "tsconfig.json"}) {
            try (InputStream input = context.getAssets().open("bunaway/" + name);
                    FileOutputStream output = new FileOutputStream(new File(directory, name))) {
                copy(input, output);
            }
        }
        return directory;
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[8192];
        int length;
        while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
    }

    /**
     * Returns the serialized origin of a URI, omitting the default HTTPS port.
     *
     * <p>URIs without a scheme or host return an empty string, which never equals a trusted origin,
     * so callers comparing origins fail closed.
     */
    static String originOf(Uri uri) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) return "";
        int port = uri.getPort();
        String suffix = port == -1 || (scheme.equals("https") && port == 443) ? "" : ":" + port;
        return scheme + "://" + host + suffix;
    }
}
