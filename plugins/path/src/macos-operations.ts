import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  appDirectorySchema,
  type PathInstance,
  pathsSchema,
  pathTextSchema,
  posixAbsolutePathSchema,
  userDirectorySchema,
} from "#path/contract";

const operation = defineNativeOperation<PathInstance>();
/** macOS POSIX lexical path helpers and OS-selected user directories, not filesystem access. */
export const macosPathOperations = {
  getDirectory: operation({
    input: z.strictObject({
      directory: userDirectorySchema,
    }),
    output: posixAbsolutePathSchema,
    handler: ({ directory }, { instance }) => instance.getDirectory(directory),
  }),
  getAppDirectory: operation({
    input: z.strictObject({
      directory: appDirectorySchema,
    }),
    output: posixAbsolutePathSchema,
    handler: ({ directory }, { instance }) =>
      instance.getAppDirectory(directory),
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
      base: posixAbsolutePathSchema,
      paths: pathsSchema,
    }),
    output: posixAbsolutePathSchema,
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
