/**
 * The deadlines every test shares. A test names what it waits for instead of picking a number, so
 * a slow runner is handled once (`BUNAWAY_TEST_TIME_SCALE`) and a value is raised in one place
 * instead of in every file that copied it. `conformance/test-deadlines.test.ts` keeps the count of
 * literal deadlines in `tests/` from growing.
 */
export const DEADLINES = {
  /** A packet, event or state change inside this process (workers, channels, fakes). */
  inProcess: 2_000,
  /** One protocol step with a Bun child this test spawned: a frame, a line, a port. */
  childStep: 10_000,
  /** A Bun child exits after the test asked it to stop. */
  childExit: 5_000,
  /** A development server, a Vite build or a template install answers. */
  toolchain: 30_000,
  /** A CLI build, a plugin build or a project install finishes. */
  build: 60_000,
  /** A real native host fixture reaches its report. */
  nativeFixture: 90_000,
  /** The packed framework installs into a fresh project and its audit runs. */
  packagedAudit: 120_000,
} as const;

export type DeadlineName = keyof typeof DEADLINES;

/** Multiplies every deadline; a slow runner sets it once instead of editing tests. */
const TIME_SCALE_VARIABLE = "BUNAWAY_TEST_TIME_SCALE";

function timeScale(): number {
  const raw = process.env[TIME_SCALE_VARIABLE];
  if (raw === undefined || raw === "") {
    return 1;
  }
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      `${TIME_SCALE_VARIABLE} must be a positive number, received ${JSON.stringify(raw)}.`,
    );
  }
  return scale;
}

/** The named deadline in milliseconds, scaled for this runner. Use it as a test's timeout too. */
export function deadline(name: DeadlineName): number {
  return Math.ceil(DEADLINES[name] * timeScale());
}

/** Kills `child` when the named deadline passes; clear the returned timer once the test is done. */
export function killAfter(
  child: {
    kill(): unknown;
  },
  name: DeadlineName,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => child.kill(), deadline(name));
}

export type WaitOptions = {
  /** Which deadline bounds the wait. */
  deadline: DeadlineName;
  /** What the wait is for, named in the timeout error. */
  what: string;
  /** Milliseconds between probes; the default suits in-process state and file polling. */
  intervalMs?: number;
  /** An error to throw at once instead of waiting on, for a child that already failed. */
  failed?: () => unknown;
};

/**
 * Polls `probe` until it returns a value other than `undefined` or `false`, and returns that
 * value. Throws naming `what` when the deadline passes first, or whatever `failed()` returns as
 * soon as it returns something.
 */
export async function waitFor<T>(
  probe: () => T | false | undefined | Promise<T | false | undefined>,
  options: WaitOptions,
): Promise<T> {
  const limit = Date.now() + deadline(options.deadline);
  const interval = options.intervalMs ?? 10;
  for (;;) {
    const failure = options.failed?.();
    if (failure !== undefined && failure !== false && failure !== null) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() >= limit) {
      throw new Error(
        `Timed out after ${deadline(options.deadline)} ms (${options.deadline}) waiting for ${options.what}.`,
      );
    }
    await Bun.sleep(interval);
  }
}
