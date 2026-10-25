import { BunawayError } from "@bunaway/plugin";
import {
  MAX_STORAGE_BYTES,
  MAX_STORAGE_TEXT_BYTES,
  MAX_STORAGE_TEXT_JSON_BYTES,
  type StorageBytesRead,
  type StorageBytesReplace,
  type StorageBytesWrite,
  type StorageLocation,
  type StorageReplace,
  type StorageWrite,
} from "#storage/contract";

/**
 * The encoding half of a storage adapter, shared by every platform. A platform supplies the two
 * primitives that touch the file system and the release of its native bindings; the text and
 * base64 operations, the size bounds and the disposed guard live here once.
 */
export abstract class StorageFiles {
  private disposed = false;

  /** Read up to `maxBytes` from the file at `path`; larger files are rejected. */
  protected abstract readFile(path: string, maxBytes: number): Buffer;
  /** Read up to `length` bytes starting at `offset`; fewer at the end of the file, none past it. */
  protected abstract readRange(
    path: string,
    offset: number,
    length: number,
  ): Buffer;
  /** Replace or append `bytes` at `path`. */
  protected abstract writeFile(
    path: string,
    bytes: Buffer,
    append: boolean,
  ): null;
  /** Replace the file at `path` with `bytes` through a temporary file swapped in at the end. */
  protected abstract replaceFile(path: string, bytes: Buffer): null;
  /** Release this adapter's native bindings; called at most once. */
  protected abstract release(): void;

  /** Release only this adapter's bindings; safe to repeat after success or failure. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.release();
  }

  /** Refuse work on a disposed adapter whose bindings are gone. */
  protected requireOpen(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Storage adapter is disposed.",
      });
    }
  }

  /**
   * Read bounded UTF-8 text from the file, preserving BOM text. The reply travels as JSON in one
   * message, so a text whose escaped form is too large is refused here instead of failing later
   * in the transport.
   */
  readText(input: StorageLocation): string {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(this.readFile(input.path, MAX_STORAGE_TEXT_BYTES));
    if (Buffer.byteLength(JSON.stringify(text)) > MAX_STORAGE_TEXT_JSON_BYTES) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Storage text is too large to return.",
      });
    }
    return text;
  }

  /** Read bounded bytes as canonical base64: the whole file, or the requested range. */
  readBytes(input: StorageBytesRead): string {
    if (input.offset === undefined && input.length === undefined) {
      return this.readFile(input.path, MAX_STORAGE_BYTES).toString("base64");
    }
    return this.readRange(
      input.path,
      input.offset ?? 0,
      input.length ?? MAX_STORAGE_BYTES,
    ).toString("base64");
  }

  /** Replace the file's text, through a temporary file when `atomic` is set. */
  writeText(input: StorageReplace): null {
    return this.replace(input.path, Buffer.from(input.text), input.atomic);
  }

  /** Append text through an append-only open and sync before reporting success. */
  appendText(input: StorageWrite): null {
    return this.writeFile(input.path, Buffer.from(input.text), true);
  }

  /** Replace the file's bytes, through a temporary file when `atomic` is set. */
  writeBytes(input: StorageBytesReplace): null {
    return this.replace(
      input.path,
      Buffer.from(input.bytes, "base64"),
      input.atomic,
    );
  }

  /** Append bytes through an append-only open and sync before reporting success. */
  appendBytes(input: StorageBytesWrite): null {
    return this.writeFile(input.path, Buffer.from(input.bytes, "base64"), true);
  }

  private replace(
    path: string,
    bytes: Buffer,
    atomic: boolean | undefined,
  ): null {
    return atomic
      ? this.replaceFile(path, bytes)
      : this.writeFile(path, bytes, false);
  }
}
