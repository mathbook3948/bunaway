import { SESSION_END_WAIT_MS } from "../../windows/bun/session-end.ts";

/** Where an operating-system session end stands, so each step runs once. */
type Phase =
  /** No session end observed. */
  | "none"
  /** Shutdown was committed; AppKit has not asked the app to terminate yet. */
  | "signalled"
  /** `applicationShouldTerminate:` answered `later`; the reply is still owed to AppKit. */
  | "waiting"
  /** AppKit has its answer (or the owner was disposed). */
  | "replied";

/**
 * Decides when an app may answer AppKit's termination request during a logout, restart or
 * shutdown, mirroring the Windows `WM_ENDSESSION` wait.
 *
 * The OS ends the session whatever the app does, so the app never vetoes it. Instead the host holds
 * the termination reply back until app cleanup (`onWillQuit` and the plugin stop hooks) finished,
 * or `SESSION_END_WAIT_MS` passed, whichever comes first. The OS may end the process right after
 * the reply, so `onQuit` and the remaining native cleanup are not guaranteed.
 */
export class SessionEndTermination {
  private phase: Phase = "none";
  private appCleaned = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param hooks.commit Commits an uncancellable shutdown for the session end. Called once.
   * @param hooks.reply Sends `replyToApplicationShouldTerminate:` to AppKit. Called at most once.
   * @param waitMs Longest wait for app cleanup; a parameter so tests need no real wait.
   */
  constructor(
    private readonly hooks: {
      commit(): void;
      reply(): void;
    },
    private readonly waitMs = SESSION_END_WAIT_MS,
  ) {}

  /** True once a session end was signalled, so every termination request is part of it. */
  get active(): boolean {
    return this.phase !== "none";
  }

  /** The first signal commits the shutdown; later signals do nothing. */
  signal(): void {
    if (this.phase !== "none") {
      return;
    }
    this.phase = "signalled";
    this.hooks.commit();
  }

  /**
   * Answers `applicationShouldTerminate:` for a session end: `now` once cleanup finished or the
   * reply was already given, otherwise `later`, after which `reply` runs exactly once.
   */
  terminateRequested(): "now" | "later" {
    this.signal();
    if (this.phase === "signalled" && !this.appCleaned) {
      this.phase = "waiting";
      this.timer = setTimeout(() => this.replyOnce(), this.waitMs);
      return "later";
    }
    if (this.phase === "waiting") {
      return "later";
    }
    this.finish();
    return "now";
  }

  /** App cleanup finished (`cleaned`): releases a waiting termination request at once. */
  appCleanedUp(): void {
    this.appCleaned = true;
    this.replyOnce();
  }

  /** Cancels the wait without replying, for when the application object is closing. Safe to repeat. */
  dispose(): void {
    this.finish();
  }

  private replyOnce(): void {
    if (this.phase !== "waiting") {
      return;
    }
    this.finish();
    this.hooks.reply();
  }

  private finish(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.phase = "replied";
  }
}
