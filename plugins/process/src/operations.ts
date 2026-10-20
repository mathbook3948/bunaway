import { defineNativeOperation } from "@bunaway/plugin";
import {
  emptyResultSchema,
  handleInputSchema,
  macosProcessInputSchema,
  type ProcessInstance,
  processInputSchema,
  processResultSchema,
  readInputSchema,
  readResultSchema,
  spawnInputSchema,
  spawnResultSchema,
  writeInputSchema,
} from "#process/contract";
import { run as runMacos } from "#process/platforms/macos";
import { run } from "#process/platforms/windows";

const operation = defineNativeOperation<ProcessInstance>();
const macosOperation = defineNativeOperation<ProcessInstance>();
/**
 * Windows runs one bounded invocation with `run`, or keeps a long-running child behind a
 * handle with `spawn`, `read`, `write`, `closeStdin` and `kill`. Neither takes a shell string.
 */
export const processOperations = {
  run: operation({
    input: processInputSchema,
    output: processResultSchema,
    handler: (input, { instance, signal }) => run(instance, input, signal),
  }),
  spawn: operation({
    input: spawnInputSchema,
    output: spawnResultSchema,
    handler: (input, { instance, source, signal }) =>
      instance.spawned.spawn(source, input, signal),
  }),
  read: operation({
    input: readInputSchema,
    output: readResultSchema,
    handler: (input, { instance, source, signal }) =>
      instance.spawned.read(source, input, signal),
  }),
  write: operation({
    input: writeInputSchema,
    output: emptyResultSchema,
    handler: async (input, { instance, source, signal }) => {
      await instance.spawned.write(source, input, signal);
      return {};
    },
  }),
  closeStdin: operation({
    input: handleInputSchema,
    output: emptyResultSchema,
    handler: async (input, { instance, source }) => {
      await instance.spawned.closeStdin(source, input);
      return {};
    },
  }),
  kill: operation({
    input: handleInputSchema,
    output: emptyResultSchema,
    handler: async (input, { instance, source }) => {
      await instance.spawned.kill(source, input);
      return {};
    },
  }),
};
/** The same operation, limits and result on macOS, with POSIX path and exec argument validation. */
export const macosProcessOperations = {
  run: macosOperation({
    input: macosProcessInputSchema,
    output: processResultSchema,
    handler: (input, { instance, signal }) => runMacos(instance, input, signal),
  }),
};
