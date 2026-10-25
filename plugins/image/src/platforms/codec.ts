import type {
  FileTypeIconSize,
  ImageInterpolation,
  ImageMime,
} from "#image/contract";

// Pixel buffers are Node Buffers because the codecs hand them to native code and copy rows with
// Buffer methods. The contract module stays free of Buffer so it can be bundled into WebView code.
export type Pixels = {
  width: number;
  height: number;
  rgba: Buffer;
};

/** The two platform codecs expose the same bounded pixel operations. */
export type ImageCodec = {
  decode(bytes: Buffer, mime: ImageMime): Pixels;
  /**
   * Decode an image file's bytes into pixels that fit within `maxDimension` and the resource pixel
   * limit, scaling while decoding so the full-size pixels are never held. Absent on platforms
   * without file image support.
   */
  decodeScaled?(bytes: Buffer, mime: ImageMime, maxDimension: number): Pixels;
  encode(pixels: Pixels, mime: ImageMime): Buffer;
  resize(
    pixels: Pixels,
    width: number,
    height: number,
    interpolation: ImageInterpolation,
  ): Pixels;
  dispose(): void;
};

/** Resolves the shell icon registered for a file extension without touching any file. */
export type FileTypeIconSource = {
  /** Throws INTERNAL on native failure or CANCELLED when aborted; the caller owns the returned detached pixels. */
  render(
    extension: string,
    size: FileTypeIconSize,
    signal?: AbortSignal,
  ): Pixels;
  /** Release native bindings; safe to repeat. */
  dispose(): void;
};
