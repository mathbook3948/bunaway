import type { Project } from "./config.ts";
import { type DevServer, startDevServer } from "./dev-server.ts";

/** Owns frontend replacement, readiness and unexpected exit reporting across app rebuilds.
 * sync() is serialized by the restart controller. close() runs after its active pass finishes.
 */
export class DevFrontend {
  private server: DevServer | undefined;
  private settings: string | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly failed: (error: Error) => void,
    private readonly start: typeof startDevServer = startDevServer,
  ) {}

  /** Releases the previous process tree before starting a replacement on the same port. */
  async sync(project: Project): Promise<void> {
    this.signal.throwIfAborted();
    if (this.closing) {
      return;
    }
    const settings = project.dev ? JSON.stringify(project.dev) : undefined;
    if (settings === this.settings) {
      return;
    }
    const previous = this.server;
    this.server = undefined;
    this.settings = undefined;
    await previous?.stop();
    this.signal.throwIfAborted();
    if (!project.dev) {
      return;
    }
    // Development cancellation owns startup only. Once ready, the frontend remains
    // available to app cleanup and is stopped explicitly by close() afterward.
    const startup = new AbortController();
    const cancelStartup = () => startup.abort(this.signal.reason);
    this.signal.addEventListener("abort", cancelStartup, {
      once: true,
    });
    let current: DevServer;
    try {
      current = await this.start(
        project.dev,
        project.root,
        startup.signal,
        project.frameworkRoot,
      );
    } finally {
      this.signal.removeEventListener("abort", cancelStartup);
    }
    // A starter that finishes after cancellation must still transfer its resource for cleanup.
    if (this.signal.aborted || this.closing) {
      await current.stop();
      this.signal.throwIfAborted();
      return;
    }
    this.server = current;
    this.settings = settings;
    void current.exited.then((code) => {
      if (this.server === current && !this.signal.aborted) {
        this.failed(
          new Error(
            `Frontend development server exited (exit ${code}). Restart bunaway dev.`,
          ),
        );
      }
    });
  }

  /** Shares final cleanup; callers keep the server available until the app has stopped. */
  close(): Promise<void> {
    if (!this.closing) {
      const previous = this.server;
      this.server = undefined;
      this.settings = undefined;
      this.closing = previous?.stop() ?? Promise.resolve();
    }
    return this.closing;
  }
}
