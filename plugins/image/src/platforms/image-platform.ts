import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import {
  type addRepresentationSchema,
  bytesSchema,
  type createFromPathSchema,
  type cropSchema,
  type exportSchema,
  type fileTypeIconSchema,
  MAX_IMAGE_DIMENSION,
  type resizeSchema,
  type rgbaSchema,
} from "#image/contract";
import type { FileTypeIconSource, ImageCodec } from "#image/platforms/codec";
import { cropPixels } from "#image/platforms/crop";
import { readImageFile } from "#image/platforms/image-file";
import { ImageResources } from "#image/platforms/resources";
/** Own decoded image resources and one platform codec for a host adapter lifetime. */
export class ImagePlatform {
  private readonly resources = new ImageResources();
  private disposed = false;
  /** Ends when the file read ahead of the newest `createFromPath` call finishes; see `createFromPath`. */
  private lastPathRead: Promise<void> = Promise.resolve();

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

  /**
   * Decode an image file into a resource that fits within `maxDimension` (default: the largest
   * image edge) and the resource pixel limit; platforms without a scaling codec report UNSUPPORTED.
   * The file is read asynchronously, so the thread that runs the plugin keeps serving other work;
   * the decode and the resource creation then run in one step without yielding. Cancellation is
   * checked after the read and again when the resource is created, and the capacity is checked
   * again then too because other calls can fill the pool while the file is read. Calls read one
   * file at a time, in call order, so the memory held for file contents stays within one file
   * (`MAX_SOURCE_FILE_BYTES`) however many calls are pending.
   */
  async createFromPath(
    input: z.output<typeof createFromPathSchema>,
    signal?: AbortSignal,
  ) {
    this.active();
    const decodeScaled = this.codec.decodeScaled?.bind(this.codec);
    if (!decodeScaled) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Image files are not supported on this platform.",
      });
    }
    this.resources.assertCapacity();
    const previousRead = this.lastPathRead;
    const finished = Promise.withResolvers<void>();
    this.lastPathRead = finished.promise;
    let file: Awaited<ReturnType<typeof readImageFile>>;
    try {
      await previousRead;
      // The adapter may have been disposed while the call waited for its turn.
      this.active();
      file = await readImageFile(input.path, signal);
    } finally {
      finished.resolve();
    }
    // The adapter may have been disposed while the file was read.
    this.active();
    return this.resources.create(
      decodeScaled(
        file.bytes,
        file.mime,
        input.maxDimension ?? MAX_IMAGE_DIMENSION,
      ),
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

  getInfo(id: string, scaleFactor?: number) {
    this.active();
    const { scaleFactor: chosen, ...info } = this.resources.selectedInfo(
      id,
      scaleFactor,
    );
    return scaleFactor === undefined
      ? info
      : {
          ...info,
          scaleFactor: chosen,
        };
  }

  addRepresentation(input: z.output<typeof addRepresentationSchema>) {
    this.active();
    return {
      representations: this.resources.addRepresentation(
        input.id,
        input.scaleFactor,
        input.source,
      ),
    };
  }

  getRepresentations(id: string) {
    this.active();
    return {
      representations: this.resources.representations(id),
    };
  }

  getPixels(id: string, scaleFactor?: number) {
    this.active();
    const { pixels } = this.resources.select(id, scaleFactor);
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
        .encode(
          this.resources.select(input.id, input.scaleFactor).pixels,
          input.format,
        )
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
