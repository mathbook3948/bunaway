import { existsSync, rmSync, writeFileSync } from "node:fs";
import { deadline } from "./deadlines.ts";

/** A mounted virtual disk; `detach` drops its mount folders and then the disk. */
export type VirtualDisk = {
  detach(): void;
};

/**
 * Run a diskpart script. False when diskpart is missing, needs elevation or fails; the caller
 * decides whether that skips the scenario or, on CI, fails the run.
 */
function diskpart(directory: string, script: string): boolean {
  const file = `${directory}/diskpart-${crypto.randomUUID().slice(0, 8)}.txt`;
  writeFileSync(file, script);
  try {
    const result = Bun.spawnSync(
      [
        "diskpart",
        "/s",
        file,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: deadline("nativeFixture"),
      },
    );
    if (result.exitCode !== 0) {
      console.log(
        `diskpart exited with ${result.exitCode}: ${result.stdout.toString().slice(-400)}`,
      );
    }
    return result.exitCode === 0;
  } catch (error) {
    // A missing executable or a refused elevation throws instead of returning an exit code.
    console.log(`diskpart could not run: ${String(error)}`);
    return false;
  } finally {
    rmSync(file, {
      force: true,
    });
  }
}

const windowsPath = (path: string) => path.replaceAll("/", "\\");

/**
 * Create a 64 MiB NTFS virtual disk in `directory` and mount it at each existing, empty folder in
 * `mountFolders`. Undefined when the runner cannot do this; nothing is left attached then.
 */
export function attachVirtualDisk(
  directory: string,
  mountFolders: string[],
): VirtualDisk | undefined {
  const disk = windowsPath(
    `${directory}/disk-${crypto.randomUUID().slice(0, 8)}.vhd`,
  );
  const folders = mountFolders.map(windowsPath);
  const detach = (): void => {
    // The disk file exists once creation started, so detach even when a later step failed.
    if (!existsSync(disk)) {
      return;
    }
    // Drop the mount points first; a mount folder left behind would point at a volume that is
    // gone once the disk is detached. A folder that was never mounted just reports an error.
    for (const folder of folders) {
      Bun.spawnSync(
        [
          "mountvol",
          folder,
          "/D",
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
          timeout: deadline("childStep"),
        },
      );
    }
    if (
      !diskpart(
        directory,
        [
          `select vdisk file="${disk}"`,
          "detach vdisk",
        ].join("\r\n"),
      )
    ) {
      console.log(`The virtual disk ${disk} could not be detached.`);
    }
  };
  const mounted = diskpart(
    directory,
    [
      `create vdisk file="${disk}" maximum=64 type=expandable`,
      `select vdisk file="${disk}"`,
      "attach vdisk",
      "create partition primary",
      "format fs=ntfs quick label=bunaway",
      ...folders.map((folder) => `assign mount="${folder}"`),
    ].join("\r\n"),
  );
  if (!mounted) {
    detach();
    return undefined;
  }
  return {
    detach,
  };
}
