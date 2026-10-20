import type { initialize } from "#plugins/process/src/platforms/windows";

/** Calls on the spawned-process table with the caller as the first argument, for tests of the handle contract. */
type Instance = ReturnType<typeof initialize>;
type Spawn = Parameters<Instance["spawned"]["spawn"]>[1];
type Read = Parameters<Instance["spawned"]["read"]>[1];
type Write = Parameters<Instance["spawned"]["write"]>[1];
type Handle = Parameters<Instance["spawned"]["kill"]>[1];

export const spawn = (instance: Instance, input: Spawn, source: string) =>
  instance.spawned.spawn(source, input);

export const read = (
  instance: Instance,
  input: Read,
  source: string,
  signal?: AbortSignal,
) => instance.spawned.read(source, input, signal);

export const write = (
  instance: Instance,
  input: Write,
  source: string,
  signal?: AbortSignal,
) => instance.spawned.write(source, input, signal);

export const closeStdin = (instance: Instance, input: Handle, source: string) =>
  instance.spawned.closeStdin(source, input);

export const kill = (instance: Instance, input: Handle, source: string) =>
  instance.spawned.kill(source, input);
