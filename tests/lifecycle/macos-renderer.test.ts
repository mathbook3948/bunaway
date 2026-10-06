import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { terminateRenderers } from "./macos-renderer.ts";

afterEach(() => mock.restore());

test("renderer termination continues past exited and inaccessible candidates", () => {
  const kill = spyOn(process, "kill").mockImplementation((pid) => {
    if (pid === 101) throw Object.assign(new Error("exited"), { code: "ESRCH" });
    if (pid === 102) throw Object.assign(new Error("inaccessible"), { code: "EPERM" });
    return true;
  });
  expect(() => terminateRenderers([101, 102, 103])).not.toThrow();
  expect(kill.mock.calls).toEqual([
    [101, "SIGKILL"],
    [102, "SIGKILL"],
    [103, "SIGKILL"],
  ]);
});

test.each(["ESRCH", "EPERM"])(
  "renderer termination still fails if all candidates return %s",
  (code) => {
    spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(() => terminateRenderers([101, 102])).toThrow("no live test renderer was terminated");
  },
);

test("renderer termination propagates unexpected signalling errors", () => {
  const error = Object.assign(new Error("invalid signal"), { code: "EINVAL" });
  spyOn(process, "kill").mockImplementation(() => {
    throw error;
  });
  expect(() => terminateRenderers([101])).toThrow(error);
});
