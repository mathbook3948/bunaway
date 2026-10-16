import { SESSION_END_WAIT_MS } from "../../windows/bun/session-end.ts";

/** Where an operating-system session end stands, so each step runs once. */
type Phase =
  /** No session end observed. */
  | "none"
  /** Shutdown was committed; the quit Apple event has not arrived yet. */
  | "signalled"
  /** The quit Apple event is suspended; its reply is still owed to the OS. */
  | "suspended"
  /** The OS has its reply, or none is owed any more. */
  | "replied";

/**
 * Decides when an app may reply to the quit Apple event of a logout, restart or shutdown,
 * mirroring the Windows `WM_ENDSESSION` wait.
 *
 * The OS ends the session whatever the app does, so the app never vetoes it: the reply is always a
 * success reply and never cancels the logout. Instead the host suspends the quit event and holds the
 * reply back until app cleanup (`onWillQuit`, the plugin stop hooks and descendant cleanup) finished,
 * or `SESSION_END_WAIT_MS` passed, whichever comes first. The OS may end the process right after the
 * reply, so `onQuit` and the remaining native cleanup are not guaranteed.
 */
export class SessionEndTermination {
  private phase: Phase = "none";
  private appCleaned = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param hooks.commit Commits an uncancellable shutdown for the session end. Called once.
   * @param hooks.reply Sends the owed success reply of the suspended quit Apple event. Called at most once.
   * @param waitMs Longest wait for app cleanup; a parameter so tests need no real wait.
   */
  constructor(
    private readonly hooks: {
      commit(): void;
      reply(): void;
    },
    private readonly waitMs = SESSION_END_WAIT_MS,
  ) {}

  /** True once a session end was signalled, so every quit request is part of it. */
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
   * Answers a quit Apple event that belongs to a session end: `now` when cleanup already finished
   * or the reply was given, so the handler just returns and the event is replied to normally.
   * Otherwise `later`: the caller suspends the event, and `reply` runs exactly once when cleanup
   * finished, the wait ran out or the owner was disposed. Every quit event answered `later` before
   * that is owed a reply, so the caller keeps all of their suspensions and resumes them in `reply`.
   */
  quitEventReceived(): "now" | "later" {
    this.signal();
    if (this.phase === "signalled" && !this.appCleaned) {
      this.phase = "suspended";
      this.timer = setTimeout(() => this.replyOnce(), this.waitMs);
      return "later";
    }
    if (this.phase === "suspended") {
      return "later";
    }
    this.finish();
    return "now";
  }

  /** App cleanup finished: releases a suspended quit event at once. */
  appCleanedUp(): void {
    this.appCleaned = true;
    this.replyOnce();
  }

  /**
   * Ends the reply obligation of a quit event that `quitEventReceived` answered `later` but that
   * could not be suspended. The OS then replies when the event handler returns, so no `reply` call is
   * owed and the wait timer is cleared. App cleanup is not marked finished: it is still running, and
   * `appCleanedUp` stays the only way to record that. Does nothing outside the suspended phase.
   */
  replyNotHeld(): void {
    if (this.phase === "suspended") {
      this.finish();
    }
  }

  /**
   * Ends the wait when the application object closes, sending a still-owed reply so the OS is never
   * left waiting. Safe to repeat.
   */
  dispose(): void {
    this.replyOnce();
    this.finish();
  }

  private replyOnce(): void {
    if (this.phase !== "suspended") {
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
