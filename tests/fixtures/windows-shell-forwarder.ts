import {
  forwardToInstance,
  parseLaunchArguments,
} from "#native/windows/bun/instance";

/**
 * The second process a registered shell command starts. It does what the host's startup does when
 * the data directory is already owned: hand its arguments and working directory to the owner over
 * the instance pipe, then exit. The first argument is the pipe address; the rest are the shell's.
 */
const [address, ...argv] = process.argv.slice(2);
if (address === undefined) {
  throw new Error("Missing instance address");
}
await forwardToInstance(
  address,
  parseLaunchArguments({
    argv,
    cwd: process.cwd(),
  }),
);
