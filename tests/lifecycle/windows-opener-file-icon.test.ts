import { expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import createOperationsDefinition from "#plugins/opener/src/index";
import { createFileIcons } from "#plugins/opener/src/platforms/windows-file-icon";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

type FileIcon = {
  mime: string;
  data: string;
  width: number;
  height: number;
};

/** Decode the PNG the adapter returned: its IHDR size, color type, and the RGBA bytes of every row. */
function decodePng(icon: FileIcon) {
  const png = Buffer.from(icon.data, "base64");
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(6);
  const idatLength = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  const rowBytes = width * 4;
  expect(raw.length).toBe((rowBytes + 1) * height);
  const alphas = new Set<number>();
  let visible = 0;
  for (let row = 0; row < height; row += 1) {
    expect(raw[row * (rowBytes + 1)]).toBe(0);
    for (let column = 0; column < width; column += 1) {
      const alpha = raw[row * (rowBytes + 1) + 1 + column * 4 + 3] ?? 0;
      alphas.add(alpha);
      if (alpha > 0) {
        visible += 1;
      }
    }
  }
  return {
    width,
    height,
    visible,
    alphas,
  };
}

async function withAdapter(
  run: (
    adapter: ReturnType<typeof createOperations>,
    root: string,
  ) => Promise<void>,
) {
  const root = resolve(
    import.meta.dir,
    `../../build/windows-opener-file-icon-${crypto.randomUUID()}`,
  );
  await mkdir(root, {
    recursive: true,
  });
  const adapter = createOperations({
    dataRoot: await realpath(root),
    capabilities: [],
  });
  try {
    await run(adapter, await realpath(root));
  } finally {
    await adapter.dispose();
  }
}

test.skipIf(process.platform !== "win32")(
  "getFileIcon renders the registered icon of an extension at each size without a file",
  async () => {
    await withAdapter(async (adapter) => {
      const edges: number[] = [];
      for (const size of [
        "small",
        "normal",
        "large",
      ]) {
        const icon = (await adapter.execute(
          "opener.getFileIcon",
          {
            extension: ".txt",
            size,
          },
          "backend",
        )) as FileIcon;
        expect(icon.mime).toBe("image/png");
        const decoded = decodePng(icon);
        expect(decoded.width).toBe(icon.width);
        expect(decoded.height).toBe(icon.height);
        expect(decoded.visible).toBeGreaterThan(0);
        edges.push(icon.width);
      }
      // A larger size never yields a smaller raster, and the whole range is not one size.
      expect(edges[0]).toBeLessThanOrEqual(edges[1] ?? 0);
      expect(edges[1]).toBeLessThanOrEqual(edges[2] ?? 0);
      expect(edges[0]).toBeLessThan(edges[2] ?? 0);
      const unknown = (await adapter.execute(
        "opener.getFileIcon",
        {
          extension: `.bunaway${Date.now()}`,
        },
        "backend",
      )) as FileIcon;
      expect(decodePng(unknown).visible).toBeGreaterThan(0);
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "getFileIcon renders the icon of an existing file and rejects a missing file or a directory",
  async () => {
    await withAdapter(async (adapter, root) => {
      const text = resolve(root, "note.txt");
      await writeFile(text, "icon");
      for (const path of [
        text,
        process.execPath,
      ]) {
        const icon = (await adapter.execute(
          "opener.getFileIcon",
          {
            path,
          },
          "backend",
        )) as FileIcon;
        const decoded = decodePng(icon);
        expect(decoded.width).toBe(icon.width);
        expect(decoded.visible).toBeGreaterThan(0);
      }
      await expect(
        adapter.execute(
          "opener.getFileIcon",
          {
            path: resolve(root, "missing.txt"),
          },
          "backend",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          details: {
            reason: "FILE_NOT_FOUND",
          },
        }),
      );
      await expect(
        adapter.execute(
          "opener.getFileIcon",
          {
            path: root,
          },
          "backend",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "the icon source rejects use after dispose",
  () => {
    const icons = createFileIcons();
    try {
      expect(
        icons.render(
          {
            extension: ".txt",
          },
          "normal",
        ).rgba.length,
      ).toBeGreaterThan(0);
    } finally {
      icons.dispose();
      icons.dispose();
    }
    expect(() =>
      icons.render(
        {
          extension: ".txt",
        },
        "normal",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
  },
);
