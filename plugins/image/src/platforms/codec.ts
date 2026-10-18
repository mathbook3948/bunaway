import type { ImageInterpolation, ImageMime } from "#image/contract";

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
  encode(pixels: Pixels, mime: ImageMime): Buffer;
  resize(
    pixels: Pixels,
    width: number,
    height: number,
    interpolation: ImageInterpolation,
  ): Pixels;
  dispose(): void;
};
