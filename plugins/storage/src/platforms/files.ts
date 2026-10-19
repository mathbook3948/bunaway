import { BunawayError } from "@bunaway/plugin";
import {
  MAX_STORAGE_BYTES,
  type StorageBytesWrite,
  type StorageLocation,
  type StorageWrite,
} from "#storage/contract";

/** Text reads and copies are bounded so one request cannot pin a multi-megabyte buffer. */
export const MAX_STORAGE_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The encoding half of a storage adapter, shared by every platform. A platform supplies the two
 * primitives that touch the file system and the release of its native bindings; the text and
 * base64 operations, the size bounds and the disposed guard live here once.
 */
export abstract class StorageFiles {
  private disposed = false;

  /** Read up to `maxBytes` from the file at `path`; larger files are rejected. */
  protected abstract readFile(path: string, maxBytes: number): Buffer;
  /** Replace or append `bytes` at `path`. */
  protected abstract writeFile(
    path: string,
    bytes: Buffer,
    append: boolean,
  ): null;
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

  /** Read bounded UTF-8 text from the file, preserving BOM text. */
  readText(input: StorageLocation): string {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(this.readFile(input.path, MAX_STORAGE_FILE_BYTES));
  }

  /** Read bounded bytes as canonical base64. */
  readBytes(input: StorageLocation): string {
    return this.readFile(input.path, MAX_STORAGE_BYTES).toString("base64");
  }

  /** Replace the file's text. */
  writeText(input: StorageWrite): null {
    return this.writeFile(input.path, Buffer.from(input.text), false);
  }

  /** Append text through an append-only open and sync before reporting success. */
  appendText(input: StorageWrite): null {
    return this.writeFile(input.path, Buffer.from(input.text), true);
  }

  /** Replace the file's bytes. */
  writeBytes(input: StorageBytesWrite): null {
    return this.writeFile(
      input.path,
      Buffer.from(input.bytes, "base64"),
      false,
    );
  }

  /** Append bytes through an append-only open and sync before reporting success. */
  appendBytes(input: StorageBytesWrite): null {
    return this.writeFile(input.path, Buffer.from(input.bytes, "base64"), true);
  }
}
