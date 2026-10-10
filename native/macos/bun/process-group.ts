import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const PROC_PGRP_ONLY = 2;
const PROC_PIDTBSDINFO = 3;
// libproc's arm64 proc_bsdinfo has a uint32 status after its uint32 flags.
const PROC_BSDINFO_BYTES = 136;
const PROC_STATUS_OFFSET = 4;
const SZOMB = 5;
const CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Isolate the host before app code runs and report unexpected guard failures.
 * Sweep after plugin cleanup, then close after Worker exit to disarm and reap the guard.
 * Reject startup when isolation fails; failed final cleanup leaves the death guard armed.
 */
export async function containMacosProcess(onFailure: (error: unknown) => void) {
  const native = dlopen("/usr/lib/libSystem.B.dylib", {
    setpgid: {
      args: [
        "i32",
        "i32",
      ],
      returns: "i32",
    },
    getpgrp: {
      args: [],
      returns: "i32",
    },
    getpgid: {
      args: [
        "i32",
      ],
      returns: "i32",
    },
    proc_listpids: {
      args: [
        "u32",
        "u32",
        "ptr",
        "i32",
      ],
      returns: "i32",
    },
    proc_pidinfo: {
      args: [
        "i32",
        "i32",
        "u64",
        "ptr",
        "i32",
      ],
      returns: "i32",
    },
  });
  const group = process.pid;
  // shortcut: other sessions/groups escape ownership; track them explicitly if detached app subprocesses need host cleanup.
  let closing = false;
  try {
    // Never signal the caller's shell or CLI process group.
    if (native.symbols.getpgrp() !== group) {
      assert.equal(
        native.symbols.setpgid(0, 0),
        0,
        "Cannot isolate macOS app process group.",
      );
    }
    const guard = spawn(
      "/bin/sh",
      [
        "-c",
        'printf "ready\\n"; if IFS= read -r completion && [ "$completion" = cleaned ]; then exit 0; fi; /bin/kill -KILL -- "-$1"',
        "bunaway-process-guard",
        String(group),
      ],
      {
        detached: true,
        env: {
          PATH: "/usr/bin:/bin",
        },
        stdio: [
          "pipe",
          "pipe",
          "ignore",
        ],
      },
    );
    const exited = new Promise<void>((resolve, reject) => {
      guard.once("error", reject);
      guard.once("exit", (code, signal) => {
        if (code === 0 && !signal) {
          resolve();
        } else {
          reject(new Error(`macOS process guard exited (${code}, ${signal}).`));
        }
      });
    });
    void exited.then(() => {
      if (!closing) {
        onFailure(new Error("macOS process guard exited unexpectedly."));
      }
    }, onFailure);
    guard.stdin.on("error", onFailure);
    try {
      const [ready] = await Promise.race([
        once(guard.stdout, "data"),
        exited.then(() => {
          throw new Error("macOS process guard exited before readiness.");
        }),
      ]);
      assert.equal(
        String(ready),
        "ready\n",
        "Invalid macOS process guard readiness.",
      );
    } catch (error) {
      closing = true;
      guard.stdin.end("cleaned\n");
      await exited.catch(() => {});
      throw error;
    }

    /** Enumerate the owned group without truncating a growing process list; zombies own no resources. */
    const descendants = (): number[] => {
      let pids = new Int32Array(256);
      let bytes: number;
      while (true) {
        bytes = native.symbols.proc_listpids(
          PROC_PGRP_ONLY,
          group,
          ptr(pids),
          pids.byteLength,
        );
        assert(
          bytes >= Int32Array.BYTES_PER_ELEMENT &&
            bytes % Int32Array.BYTES_PER_ELEMENT === 0,
          "Cannot inspect macOS app process group.",
        );
        if (bytes < pids.byteLength) {
          break;
        }
        pids = new Int32Array(pids.length * 2);
      }
      const info = Buffer.alloc(PROC_BSDINFO_BYTES);
      return [
        ...pids.subarray(0, bytes / Int32Array.BYTES_PER_ELEMENT),
      ].filter((pid) => {
        if (
          pid <= 0 ||
          pid === group ||
          native.symbols.getpgid(pid) !== group
        ) {
          return false;
        }
        const size = native.symbols.proc_pidinfo(
          pid,
          PROC_PIDTBSDINFO,
          0n,
          ptr(info),
          info.length,
        );
        return (
          size !== info.length ||
          info.readUInt32LE(PROC_STATUS_OFFSET) !== SZOMB
        );
      });
    };
    /** Sweep after plugin cleanup, or after forced Worker exit; safe to repeat. */
    const stopDescendants = async (): Promise<void> => {
      const deadline = performance.now() + CLEANUP_TIMEOUT_MS;
      while (true) {
        const pids = descendants();
        if (!pids.length) {
          return;
        }
        for (const pid of pids) {
          if (native.symbols.getpgid(pid) !== group) {
            continue;
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
        }
        assert(
          performance.now() < deadline,
          "macOS app descendant cleanup timed out.",
        );
        await Bun.sleep(10);
      }
    };
    let closed: Promise<void> | undefined;
    return {
      guardPid: guard.pid,
      stopDescendants,
      /** Disarm the death guard only after all inherited subprocesses have stopped. */
      close(): Promise<void> {
        closed ??= (async () => {
          try {
            await stopDescendants();
            closing = true;
            guard.stdin.end("cleaned\n");
            await exited;
          } catch (error) {
            // EOF leaves the guard armed: failed cleanup must not leak the group.
            guard.stdin.destroy();
            throw error;
          } finally {
            native.close();
          }
        })();
        return closed;
      },
    };
  } catch (error) {
    native.close();
    throw error;
  }
}
