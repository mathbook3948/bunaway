import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import {
  bytesSchema,
  type cropSchema,
  type exportSchema,
  type fileTypeIconSchema,
  type resizeSchema,
  type rgbaSchema,
} from "#image/contract";
import type { FileTypeIconSource, ImageCodec } from "#image/platforms/codec";
import { cropPixels } from "#image/platforms/crop";
import { ImageResources } from "#image/platforms/resources";
/** Own decoded image resources and one platform codec for a host adapter lifetime. */
export class ImagePlatform {
  private readonly resources = new ImageResources();
  private disposed = false;

  constructor(
    private readonly codec: ImageCodec,
    private readonly fileTypeIcons?: FileTypeIconSource,
  ) {}

  private active(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Image operation cancelled.",
      });
    }
  }

  createRGBA(input: z.output<typeof rgbaSchema>, signal?: AbortSignal) {
    this.active();
    return this.resources.create(
      {
        ...input,
        rgba: Buffer.from(input.rgba, "base64"),
      },
      signal,
    );
  }

  createBytes(input: z.output<typeof bytesSchema>, signal?: AbortSignal) {
    this.active();
    this.resources.assertCapacity();
    return this.resources.create(
      this.codec.decode(Buffer.from(input.data, "base64"), input.mime),
      signal,
    );
  }

  createDataURL(url: string, signal?: AbortSignal) {
    this.active();
    this.resources.assertCapacity();
    const separator = url.indexOf(",");
    const bytes = bytesSchema.parse({
      mime: url.slice(5, url.indexOf(";")),
      data: url.slice(separator + 1),
    });
    return this.resources.create(
      this.codec.decode(Buffer.from(bytes.data, "base64"), bytes.mime),
      signal,
    );
  }

  /** Create an icon for a file extension; platforms without a source report UNSUPPORTED. */
  createFileTypeIcon(
    input: z.output<typeof fileTypeIconSchema>,
    signal?: AbortSignal,
  ) {
    this.active();
    if (!this.fileTypeIcons) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "File type icons are not supported on this platform.",
      });
    }
    this.resources.assertCapacity();
    return this.resources.create(
      this.fileTypeIcons.render(input.extension, input.size, signal),
      signal,
    );
  }

  getInfo(id: string) {
    this.active();
    return this.resources.info(id);
  }

  getPixels(id: string) {
    this.active();
    const pixels = this.resources.get(id);
    return {
      width: pixels.width,
      height: pixels.height,
      rgba: pixels.rgba.toString("base64"),
    };
  }

  exportBytes(input: z.output<typeof exportSchema>) {
    this.active();
    return {
      mime: input.format,
      data: this.codec
        .encode(this.resources.get(input.id), input.format)
        .toString("base64"),
    };
  }

  exportDataURL(input: z.output<typeof exportSchema>) {
    const bytes = this.exportBytes(input);
    return `data:${bytes.mime};base64,${bytes.data}`;
  }

  remove(id: string): boolean {
    this.active();
    return this.resources.remove(id);
  }

  crop(input: z.output<typeof cropSchema>, signal?: AbortSignal) {
    this.active();
    const source = this.resources.get(input.id);
    this.resources.assertCapacity();
    return this.resources.create(cropPixels(source, input), signal);
  }

  resize(input: z.output<typeof resizeSchema>, signal?: AbortSignal) {
    this.active();
    const source = this.resources.get(input.id);
    this.resources.assertCapacity();
    return this.resources.create(
      this.codec.resize(
        source,
        input.width,
        input.height,
        input.interpolation ?? "linear",
      ),
      signal,
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.resources.dispose();
    this.fileTypeIcons?.dispose();
    this.codec.dispose();
  }
}
