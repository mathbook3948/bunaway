import {
  type AppReloadRequest,
  type AppReloadResult,
  readAppReloadResult,
} from "@bunaway/runtime-bun/development";
import type { Subprocess } from "bun";

const RELOAD_TIMEOUT_MS = 30000;

export class WindowsAppReload {
  private readonly ready = Promise.withResolvers<void>();
  private child: Subprocess | undefined;
  private pending:
    | {
        id: string;
        resolve(result: AppReloadResult): void;
        reject(error: unknown): void;
      }
    | undefined;

  constructor() {
    void this.ready.promise.catch(() => {});
  }

  attach(child: Subprocess): void {
    this.child = child;
    void child.exited.then(() => this.close());
  }

  receive(value: unknown): void {
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

  close(): void {
    const error = new Error("Development app connection closed.");
    this.ready.reject(error);
    this.pending?.reject(error);
    this.child = undefined;
  }
}
