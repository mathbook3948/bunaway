import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  pathsSchema,
  pathTextSchema,
  qualifiedPathSchema,
  userDirectorySchema,
} from "./contract.ts";
import type { WindowsPath } from "./platforms/windows.ts";

const operation = defineNativeOperation<WindowsPath>();
/** Windows lexical path helpers and OS-selected user directories, not filesystem access. */
export const pathOperations = {
  getDirectory: operation({
    input: z.strictObject({
      directory: userDirectorySchema,
    }),
    output: qualifiedPathSchema,
    handler: ({ directory }, { instance }) => instance.getDirectory(directory),
  }),
  join: operation({
    input: z.strictObject({
      paths: pathsSchema,
    }),
    output: pathTextSchema,
    handler: ({ paths }, { instance }) => instance.join(paths),
  }),
  resolve: operation({
    input: z.strictObject({
      base: qualifiedPathSchema,
      // Per-drive relative paths would consult the host's implicit drive working directory.
      paths: pathsSchema.refine((values) =>
        values.every((value) => !/^[A-Za-z]:(?![\\/])/.test(value)),
      ),
    }),
    output: qualifiedPathSchema,
    handler: ({ base, paths }, { instance }) => instance.resolve(base, paths),
  }),
  normalize: operation({
    input: z.strictObject({
      path: pathTextSchema,
    }),
    output: pathTextSchema,
    handler: ({ path }, { instance }) => instance.normalize(path),
  }),
  basename: operation({
    input: z.strictObject({
      path: pathTextSchema,
      suffix: pathTextSchema.optional(),
    }),
    output: pathTextSchema,
    handler: ({ path, suffix }, { instance }) =>
      instance.basename(path, suffix),
  }),
  dirname: operation({
    input: z.strictObject({
      path: pathTextSchema,
    }),
    output: pathTextSchema,
    handler: ({ path }, { instance }) => instance.dirname(path),
  }),
  extname: operation({
    input: z.strictObject({
      path: pathTextSchema,
    }),
    output: pathTextSchema,
    handler: ({ path }, { instance }) => instance.extname(path),
  }),
  isAbsolute: operation({
    input: z.strictObject({
      path: pathTextSchema,
    }),
    output: z.boolean(),
    handler: ({ path }, { instance }) => instance.isAbsolute(path),
  }),
};
