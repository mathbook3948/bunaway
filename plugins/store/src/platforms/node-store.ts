import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { NativeEnvironment } from "@bunaway/plugin";
import { attemptAll, failWithCleanup } from "@bunaway/plugin";
import { BunawayError, isRecord } from "@bunaway/protocol";
import {
  DEFAULT_AUTOSAVE_DELAY_MS,
  MAX_OPEN_STORES,
  MAX_STORE_FILE_BYTES,
  MAX_STORE_KEY_LENGTH,
  MAX_STORE_KEYS,
  MAX_STORE_VALUE_BYTES,
  type StoreChange,
  type StoreGetResult,
  type StoreInstance,
  type StoreLoadInput,
  type StoreLoadResult,
  type StoreRecord,
  type StoreValue,
} from "#store/contract";

/**
 * Waits between attempts to replace the store file. A virus scanner or indexer that holds the
 * target open makes the rename fail briefly with `EPERM`, `EACCES` or `EBUSY` on Windows.
 */
const RENAME_RETRY_DELAYS_MS = [
  10,
  20,
  40,
  80,
  160,
];
const TRANSIENT_RENAME_CODES = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);
const PERMISSION_CODES = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);
const STORE_DIRECTORY_MODE = 0o700;
const STORE_FILE_MODE = 0o600;
const JSON_INDENT = 2;

/** File operations the store depends on; tests replace them to rehearse rename failures. */
export interface StoreFileOperations {
  rename(from: string, to: string): void;
  /** Block the calling worker for `milliseconds`; saves are synchronous by design. */
  sleep(milliseconds: number): void;
}

const systemOperations: StoreFileOperations = {
  rename: renameSync,
  sleep(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
};

interface OpenStore {
  readonly name: string;
  readonly path: string;
  readonly defaults: StoreRecord | undefined;
  readonly autosave: number | false;
  readonly onInvalidFile: "error" | "reset";
  /** Canonical text of the options passed to `load`, to recognise a repeated load. */
  readonly optionsKey: string;
  data: Map<string, StoreValue>;
  loaded: StoreLoadResult["loaded"];
  /** Whether memory holds changes the file does not. */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Contents = {
  data: Map<string, StoreValue>;
  source: StoreLoadResult["loaded"];
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {
  fatal: true,
});

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function invalid(message: string, reason?: string): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
    ...(reason === undefined
      ? {}
      : {
          details: {
            reason,
          },
        }),
  });
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Report a refused file access as a protocol error and leave other failures to the host. */
function storeIoError(error: unknown): unknown {
  const code = errorCode(error);
  if (error instanceof BunawayError || code === undefined) {
    return error;
  }
  if (!PERMISSION_CODES.has(code)) {
    return error;
  }
  const failure = new BunawayError({
    code: "PERMISSION_DENIED",
    message: "The store file cannot be accessed.",
  });
  failure.cause = error;
  return failure;
}

/**
 * Serialize the entries as one JSON object. Keys keep their insertion order except that
 * integer-like keys ("1", "42") come first in ascending order, as in every JavaScript object, so
 * a store read back from its file lists them that way.
 */
function serialize(data: Map<string, StoreValue>): string {
  return JSON.stringify(Object.fromEntries(data), null, JSON_INDENT);
}

/** Each value must fit the per-value limit, wherever it came from. */
function checkValueSizes(data: Map<string, StoreValue>): void {
  for (const value of data.values()) {
    if (byteLength(JSON.stringify(value)) > MAX_STORE_VALUE_BYTES) {
      throw invalid("A value exceeds its size limit.", "value-too-large");
    }
  }
}

function checkFileSize(data: Map<string, StoreValue>): void {
  if (byteLength(serialize(data)) > MAX_STORE_FILE_BYTES) {
    throw invalid("The store would exceed its size limit.", "file-too-large");
  }
}

function invalidFile(message: string): BunawayError {
  return invalid(`The store file is damaged: ${message}`, "invalid-file");
}

/** Parse the store file; absent means a store that was never saved. */
function readFile(path: string): StoreRecord | undefined {
  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) {
      throw invalidFile("it is not a regular file.");
    }
    size = info.size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (size > MAX_STORE_FILE_BYTES) {
    throw invalidFile("it exceeds the size limit.");
  }
  // A read failure (access denied) is not damage; only decoding and parsing are.
  const bytes = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw invalidFile("it is not valid UTF-8 JSON.");
  }
  if (!isRecord(parsed)) {
    throw invalidFile("the top level is not an object.");
  }
  const keys = Object.keys(parsed);
  if (
    keys.length > MAX_STORE_KEYS ||
    keys.some((key) => key.length === 0 || key.length > MAX_STORE_KEY_LENGTH)
  ) {
    throw invalidFile("it exceeds the key limits.");
  }
  // JSON.parse produced the values, so each one is already a JSON value.
  return parsed as StoreRecord;
}

/** The file over the defaults, per key, checked against every limit. */
function mergeContents(
  defaults: StoreRecord,
  stored: StoreRecord | undefined,
): Contents {
  const data = new Map(Object.entries(defaults));
  for (const [key, value] of Object.entries(stored ?? {})) {
    data.set(key, value);
  }
  if (data.size > MAX_STORE_KEYS) {
    throw invalid("The stored keys and defaults exceed the key limit.");
  }
  checkValueSizes(data);
  checkFileSize(data);
  return {
    data,
    source: stored === undefined ? "new" : "file",
  };
}

/**
 * Named JSON key-value stores kept in memory and saved to `<dataRoot>/data/stores/<name>.json`.
 *
 * Callers pass a store name, never a path. Every operation runs synchronously on the plugin's
 * worker, which executes one operation at a time, so no operation interleaves with another or
 * with an autosave timer. Another process writing the same file is not coordinated: the last
 * writer wins. Windows refuses a second instance of the same app, so only programs outside the
 * app, or a second macOS instance, can do that.
 *
 * Each open store owns a debounce timer and, while saving, a temporary file. `dispose` stops the
 * timers and saves what is still unsaved; later calls fail with `CANCELLED`.
 */
export class NodeStore implements StoreInstance {
  private readonly directory: string;
  private readonly stores = new Map<string, OpenStore>();
  private disposed = false;

  constructor(
    dataRoot: string,
    private readonly files: StoreFileOperations = systemOperations,
  ) {
    this.directory = resolve(dataRoot, "data", "stores");
  }

  load(input: StoreLoadInput): StoreLoadResult {
    this.ensureActive();
    const autosave = input.autosave ?? DEFAULT_AUTOSAVE_DELAY_MS;
    const onInvalidFile = input.onInvalidFile ?? "error";
    const optionsKey = JSON.stringify([
      input.defaults ?? null,
      autosave,
      onInvalidFile,
    ]);
    const open = this.stores.get(input.name);
    if (open !== undefined) {
      if (open.optionsKey !== optionsKey) {
        throw invalid("The store is already loaded with different options.");
      }
      return {
        loaded: open.loaded,
      };
    }
    if (this.stores.size >= MAX_OPEN_STORES) {
      throw new BunawayError({
        code: "BUSY",
        message: "Too many stores are open.",
      });
    }
    const defaults = input.defaults;
    if (defaults !== undefined) {
      const defaultEntries = new Map(Object.entries(defaults));
      checkValueSizes(defaultEntries);
      checkFileSize(defaultEntries);
      if (Object.keys(defaults).length > MAX_STORE_KEYS) {
        throw invalid("The defaults exceed the key limit.");
      }
    }
    const store: OpenStore = {
      name: input.name,
      path: resolve(this.directory, `${input.name}.json`),
      defaults,
      autosave,
      onInvalidFile,
      optionsKey,
      data: new Map(),
      loaded: "new",
      dirty: false,
      timer: undefined,
    };
    const contents = this.readContents(store, false);
    store.data = contents.data;
    store.loaded = contents.source;
    if (contents.source === "reset") {
      this.markDirty(store);
    }
    this.stores.set(store.name, store);
    return {
      loaded: store.loaded,
    };
  }

  get(name: string, key: string): StoreGetResult {
    const value = this.open(name).data.get(key);
    return value === undefined
      ? {
          found: false,
        }
      : {
          found: true,
          value,
        };
  }

  has(name: string, key: string): boolean {
    return this.open(name).data.has(key);
  }

  keys(name: string): string[] {
    return [
      ...this.open(name).data.keys(),
    ];
  }

  entries(name: string): Array<
    [
      string,
      StoreValue,
    ]
  > {
    return [
      ...this.open(name).data.entries(),
    ];
  }

  length(name: string): number {
    return this.open(name).data.size;
  }

  set(name: string, key: string, value: StoreValue): StoreChange {
    const store = this.open(name);
    const text = JSON.stringify(value);
    if (byteLength(text) > MAX_STORE_VALUE_BYTES) {
      throw invalid("The value exceeds its size limit.");
    }
    const previous = store.data.get(key);
    if (previous !== undefined && JSON.stringify(previous) === text) {
      return {
        changed: false,
      };
    }
    if (previous === undefined && store.data.size >= MAX_STORE_KEYS) {
      throw invalid("The store holds the most keys it allows.");
    }
    store.data.set(key, value);
    try {
      checkFileSize(store.data);
    } catch (error) {
      // Refuse the change as a whole: memory must keep matching what was accepted.
      if (previous === undefined) {
        store.data.delete(key);
      } else {
        store.data.set(key, previous);
      }
      throw error;
    }
    this.markDirty(store);
    return {
      changed: true,
    };
  }

  delete(name: string, key: string): StoreChange {
    const store = this.open(name);
    if (!store.data.delete(key)) {
      return {
        changed: false,
      };
    }
    this.markDirty(store);
    return {
      changed: true,
    };
  }

  clear(name: string): StoreChange {
    return this.replace(this.open(name), new Map());
  }

  /** Back to the defaults given to `load`, or empty when there were none. */
  reset(name: string): StoreChange {
    const store = this.open(name);
    return this.replace(store, new Map(Object.entries(store.defaults ?? {})));
  }

  /** Read the file again, dropping unsaved changes. `ignoreDefaults` keeps only what the file holds. */
  reload(name: string, ignoreDefaults: boolean): StoreChange {
    const store = this.open(name);
    const before = serialize(store.data);
    const contents = this.readContents(store, ignoreDefaults);
    this.cancelTimer(store);
    store.data = contents.data;
    store.loaded = contents.source;
    store.dirty = false;
    if (contents.source === "reset") {
      this.markDirty(store);
    }
    return {
      changed: serialize(store.data) !== before,
    };
  }

  /** Write the store now, even when nothing changed, so a new store gets its file. */
  save(name: string): null {
    this.persist(this.open(name));
    return null;
  }

  /** Save unsaved changes, then forget the store; a failed save leaves it open for a retry. */
  close(name: string): null {
    this.ensureActive();
    const store = this.stores.get(name);
    if (store === undefined) {
      return null;
    }
    this.cancelTimer(store);
    if (store.dirty) {
      this.persist(store);
    }
    this.stores.delete(name);
    return null;
  }

  /** Stop every timer and save what is unsaved; every store is attempted even if one fails. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const stores = [
      ...this.stores.values(),
    ];
    this.stores.clear();
    attemptAll(
      stores.map((store) => () => {
        this.cancelTimer(store);
        if (store.dirty) {
          this.persist(store);
        }
      }),
      "Failed to save stores at shutdown.",
    );
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Store adapter is disposed.",
      });
    }
  }

  private open(name: string): OpenStore {
    this.ensureActive();
    const store = this.stores.get(name);
    if (store === undefined) {
      throw invalid("The store is not loaded.");
    }
    return store;
  }

  /** Swap the contents for `next`, reporting whether they differ. */
  private replace(
    store: OpenStore,
    next: Map<string, StoreValue>,
  ): StoreChange {
    if (serialize(next) === serialize(store.data)) {
      return {
        changed: false,
      };
    }
    store.data = next;
    this.markDirty(store);
    return {
      changed: true,
    };
  }

  /** Contents for a fresh load or a reload: the file over the defaults, per key. */
  private readContents(store: OpenStore, ignoreDefaults: boolean): Contents {
    const defaults = ignoreDefaults ? {} : (store.defaults ?? {});
    try {
      return mergeContents(defaults, readFile(store.path));
    } catch (error) {
      // A file the store cannot hold (damaged, or beyond a limit once merged with the defaults)
      // is replaced by the next save when the caller chose to start over. Access failures are
      // never treated as damage.
      if (
        store.onInvalidFile === "reset" &&
        error instanceof BunawayError &&
        error.code === "INVALID_ARGUMENT"
      ) {
        return {
          data: new Map(Object.entries(defaults)),
          source: "reset",
        };
      }
      throw storeIoError(error);
    }
  }

  private markDirty(store: OpenStore): void {
    store.dirty = true;
    this.cancelTimer(store);
    if (store.autosave === false) {
      return;
    }
    store.timer = setTimeout(() => {
      store.timer = undefined;
      try {
        this.persist(store);
      } catch {
        // The store stays dirty. The next change, save, close or shutdown tries again and
        // reports the failure to a caller that can act on it.
      }
    }, store.autosave);
    store.timer.unref();
  }

  private cancelTimer(store: OpenStore): void {
    if (store.timer !== undefined) {
      clearTimeout(store.timer);
      store.timer = undefined;
    }
  }

  /**
   * Replace the file with the current contents: write a temporary file next to it, flush it,
   * then rename it over the target so a crash leaves either the old or the new file.
   */
  private persist(store: OpenStore): void {
    this.cancelTimer(store);
    const text = serialize(store.data);
    const temporary = `${store.path}.tmp`;
    try {
      mkdirSync(this.directory, {
        recursive: true,
        mode: STORE_DIRECTORY_MODE,
      });
      try {
        this.writeTemporary(temporary, text);
        this.renameWithRetry(temporary, store.path);
      } catch (error) {
        failWithCleanup(
          error,
          () =>
            rmSync(temporary, {
              force: true,
            }),
          "Failed to save the store and remove its temporary file.",
        );
      }
    } catch (error) {
      throw storeIoError(error);
    }
    store.dirty = false;
  }

  private writeTemporary(path: string, text: string): void {
    const handle = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      STORE_FILE_MODE,
    );
    try {
      writeFileSync(handle, text);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }

  private renameWithRetry(from: string, to: string): void {
    for (let attempt = 0; ; attempt++) {
      try {
        this.files.rename(from, to);
        return;
      } catch (error) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        const code = errorCode(error);
        if (
          delay === undefined ||
          code === undefined ||
          !TRANSIENT_RENAME_CODES.has(code)
        ) {
          throw error;
        }
        this.files.sleep(delay);
      }
    }
  }
}

/** Create the store registry for the app's data directory. */
export function initialize(environment: NativeEnvironment): NodeStore {
  return new NodeStore(environment.dataRoot);
}

/** Save unsaved stores and release their timers at shutdown. */
export function dispose(instance: NodeStore): void {
  instance.dispose();
}
