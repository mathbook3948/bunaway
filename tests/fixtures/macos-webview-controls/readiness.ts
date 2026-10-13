type WaitFor = (
  check: () => boolean | Promise<boolean>,
  stage: string,
) => Promise<void>;

/** Wait for each main document's held command to start before the fixture leaves it. */
export function controlsClientReadiness(progress: {
  arrivals: ReadonlyMap<string, number>;
  held: ReadonlyMap<string, number>;
  isLoading(): Promise<boolean>;
  waitFor: WaitFor;
}) {
  return async (path: string, count = 1) => {
    // Arrival is counted before its response reaches the browser, which submits
    // test.hold afterward. Both must reach this generation before navigation.
    await progress.waitFor(
      () =>
        (progress.arrivals.get(path) ?? 0) >= count &&
        (progress.held.get(path) ?? 0) >= count,
      `arrival ${path} ${count}`,
    );
    await progress.waitFor(
      async () => !(await progress.isLoading()),
      `loaded ${path}`,
    );
  };
}
