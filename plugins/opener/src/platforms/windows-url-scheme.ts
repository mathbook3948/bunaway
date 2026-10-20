import { failWithCleanup, type NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { quoteShellTarget } from "#opener/platforms/windows-shell";

/** Longest registered command, in UTF-16 units; the Shell truncates longer command lines. */
export const MAX_SCHEME_COMMAND_UNITS = 2048;
/** Value on the scheme key that marks a registration made by this plugin for one app. */
export const OWNER_VALUE = "BunawayRegistration";
const URL_PROTOCOL_VALUE = "URL Protocol";

/**
 * Registry access for the user's classes hive. Paths are relative to HKEY_CURRENT_USER and a
 * `name` of `""` is the key's default value. Reads return null for a missing key or value.
 */
export interface SchemeStore {
  /** Run `work` while no other opener in this session changes the scheme; contention is BUSY. */
  withLock<T>(scheme: string, work: () => T): T;
  keyExists(path: string): boolean;
  /**
   * True when the merged classes view (HKCR: user classes over machine classes) has a key
   * with this name, which covers machine-wide registrations and system ProgIds.
   */
  classExists(name: string): boolean;
  readString(path: string, name: string): string | null;
  /** Create the key when missing and set one string value. */
  writeString(path: string, name: string, value: string): void;
  /** Delete the key with everything below it; a missing key is not an error. */
  deleteTree(path: string): void;
  /** Tell the Shell that file and protocol associations changed. */
  notifyAssociationsChanged(): void;
}

export type AppLaunch = NonNullable<NativeEnvironment["app"]>;

/**
 * Build the command the Shell runs for a link: the app's own launch command followed by the
 * URL as the last argument. Every part is quoted with the Windows argv rules. A `%` is
 * rejected because the Shell expands `%1`, `%*` and similar placeholders even inside quotes.
 */
export function buildSchemeCommand(launch: AppLaunch["launch"]): string {
  const parts = [
    launch.executablePath,
    ...launch.args,
  ];
  if (parts.some((part) => /[\p{Cc}%]/u.test(part))) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message:
        "The app launch command contains characters that cannot be registered as a URL handler.",
    });
  }
  const command = `${parts.map(quoteShellTarget).join(" ")} "%1"`;
  if (command.length > MAX_SCHEME_COMMAND_UNITS) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "The app launch command is too long to register.",
    });
  }
  return command;
}

/**
 * Per-user registration of this app as the handler of custom URL schemes under
 * `HKCU\Software\Classes\<scheme>`, in the shape Electron and Tauri write. A scheme key
 * belongs to this app only while its owner value and its command both equal the ones this
 * app writes; keys of other owners, including installer registrations, are never changed.
 * The user's default-app choice and HKLM are not touched.
 */
export function createUrlSchemeRegistration(
  app: AppLaunch | undefined,
  store: SchemeStore,
) {
  /** The app identity is host supplied; without it the operations cannot name an owner. */
  function identity(): {
    owner: string;
    command: string;
  } {
    if (app === undefined) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "URL scheme registration needs the host app identity.",
      });
    }
    return {
      // Development and packaged runs of one app id keep separate registrations.
      owner: `${app.launch.mode}.${app.id}`,
      command: buildSchemeCommand(app.launch),
    };
  }

  const keyPath = (scheme: string) => `Software\\Classes\\${scheme}`;
  const commandPath = (scheme: string) =>
    `${keyPath(scheme)}\\shell\\open\\command`;

  /** True when this app owns the key and its command still starts this app. */
  function ownsRegistration(
    scheme: string,
    owner: string,
    command: string,
  ): boolean {
    return (
      store.readString(keyPath(scheme), OWNER_VALUE) === owner &&
      store.readString(commandPath(scheme), "") === command
    );
  }

  return {
    /**
     * Register the app for the scheme, or refresh its command after the app moved. An
     * existing name owned by anything else, in HKCU or the merged classes view, is left alone and reported as INVALID_ARGUMENT.
     * `URL Protocol` is written last because the Shell ignores a key without it, so a
     * failure part way never leaves a runnable but half-written handler.
     */
    register(scheme: string): null {
      const { owner, command } = identity();
      store.withLock(scheme, () => {
        const key = keyPath(scheme);
        const existed = store.keyExists(key);
        // A name present only in HKLM (or a system ProgId such as exefile) would be
        // overridden for this user by a new HKCU key, so it counts as taken.
        const taken = existed
          ? store.readString(key, OWNER_VALUE) !== owner
          : store.classExists(scheme);
        if (taken) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "The URL scheme is registered by another owner.",
          });
        }
        if (
          ownsRegistration(scheme, owner, command) &&
          store.readString(key, URL_PROTOCOL_VALUE) !== null
        ) {
          return;
        }
        try {
          store.writeString(key, OWNER_VALUE, owner);
          store.writeString(key, "", `URL:${scheme}`);
          store.writeString(commandPath(scheme), "", command);
          store.writeString(key, URL_PROTOCOL_VALUE, "");
        } catch (error) {
          // Remove only a key this call created; a refreshed key stays registered by the app.
          if (!existed) {
            failWithCleanup(
              error,
              () => store.deleteTree(key),
              "URL scheme registration failed and could not be rolled back.",
            );
          }
          throw error;
        }
        store.notifyAssociationsChanged();
      });
      return null;
    },

    /** Remove the scheme key when this app owns it. Returns whether a key was removed. */
    unregister(scheme: string): boolean {
      const { owner, command } = identity();
      return store.withLock(scheme, () => {
        if (!ownsRegistration(scheme, owner, command)) {
          return false;
        }
        store.deleteTree(keyPath(scheme));
        store.notifyAssociationsChanged();
        return true;
      });
    },

    /** True when the registry holds this app's complete registration for the scheme. */
    isRegistered(scheme: string): boolean {
      const { owner, command } = identity();
      return (
        ownsRegistration(scheme, owner, command) &&
        store.readString(keyPath(scheme), URL_PROTOCOL_VALUE) !== null
      );
    },
  };
}
