import {
  type AppRelaunchAck,
  type AppReloadRequest,
  type AppReloadResult,
  readAppRelaunchRequest,
  readAppReloadResult,
} from "@bunaway/runtime-bun/development";
import type { Subprocess } from "bun";

const RELOAD_TIMEOUT_MS = 30000;

/** Manage readiness and request/reply IPC for a Windows development app. */
export class WindowsAppReload {
  private readonly ready = Promise.withResolvers<void>();
  private child: Subprocess | undefined;
  private relaunchArgv: readonly string[] | undefined;
  private pending:
    | {
        id: string;
        resolve(result: AppReloadResult): void;
        reject(error: unknown): void;
      }
    | undefined;

  constructor() {
    // Marks the rejection handled so an unused readiness failure is not an unhandled rejection;
    // reload() awaits the same promise and reports the error to its caller.
    void this.ready.promise.catch(() => {
      // Observed by reload().
    });
  }

  /** Attach the launched app process and close the connection when it exits. */
  attach(child: Subprocess): void {
    this.child = child;
    void child.exited.then(() => this.close());
  }

  /** Arguments of the relaunch the app asked for before exiting; undefined if it did not. */
  get relaunch(): readonly string[] | undefined {
    return this.relaunchArgv;
  }

  /** Route readiness, relaunch and result messages; malformed results reject the pending request. */
  receive(value: unknown): void {
    if (
      value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "bunaway:relaunch-app"
    ) {
      try {
        this.relaunchArgv = readAppRelaunchRequest(value).argv;
        // The host waits for this reply before it exits, so the request is never missed.
        this.child?.send({
          kind: "bunaway:relaunch-ack",
        } satisfies AppRelaunchAck);
      } catch (error) {
        console.error(error);
      }
      return;
    }
    if (
      value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "bunaway:reload-ready" &&
      Object.keys(value).length === 1
    ) {
      this.ready.resolve();
      return;
    }
    try {
      const result = readAppReloadResult(value);
      if (this.pending?.id === result.id) {
        this.pending.resolve(result);
      }
    } catch (error) {
      this.pending?.reject(error);
    }
  }

  /** Wait for readiness, send one reload request and reject on timeout or child exit. */
  async reload(request: AppReloadRequest): Promise<AppReloadResult> {
    const timer = setTimeout(() => {
      const error = new Error("App reload timed out; restart bunaway dev.");
      this.ready.reject(error);
      this.pending?.reject(error);
    }, RELOAD_TIMEOUT_MS);
    try {
      await this.ready.promise;
      const child = this.child;
      if (!child || child.exitCode !== null) {
        throw new Error("Development app exited.");
      }
      const result = new Promise<AppReloadResult>((resolve, reject) => {
        // Register before sending because the child may reply immediately.
        this.pending = {
          id: request.id,
          resolve,
          reject,
        };
      });
      child.send(request);
      return await result;
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
    }
  }

  /** Reject readiness and any pending request after the child connection closes. */
  close(): void {
    const error = new Error("Development app connection closed.");
    this.ready.reject(error);
    this.pending?.reject(error);
    this.child = undefined;
  }
}
