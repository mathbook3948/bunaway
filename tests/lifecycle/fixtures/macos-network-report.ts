/** Poll a report written by the host without retaining BunFile's cached missing-file state. */
export async function readNetworkReport(path: string): Promise<unknown> {
  if (!(await Bun.file(path).exists())) {
    return undefined;
  }
  try {
    return await Bun.file(path).json();
  } catch (error) {
    // The host may still be writing when the file first becomes visible.
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}
