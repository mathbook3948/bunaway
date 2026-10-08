import { expect, test } from "bun:test";
import { constrainedOuterSize } from "../../native/windows/bun/window-size.ts";

const unconstrained = {
  minWidth: null,
  minHeight: null,
  maxWidth: null,
  maxHeight: null,
};

test("maximized sizes use the target monitor and preserve unconstrained axes", () => {
  const frame = {
    width: 16,
    height: 39,
  };
  // A 2560-pixel target monitor is wider than the 1920-pixel primary monitor.
  expect(
    constrainedOuterSize(2576, 1456, 96, frame, {
      ...unconstrained,
      maxWidth: 2000,
    }),
  ).toEqual({
    width: 2016,
    height: 1456,
  });
  expect(
    constrainedOuterSize(1936, 1096, 96, frame, {
      ...unconstrained,
      minWidth: 2000,
    }),
  ).toEqual({
    width: 2016,
    height: 1096,
  });
  expect(
    constrainedOuterSize(2576, 1456, 96, frame, {
      ...unconstrained,
      maxHeight: 900,
    }),
  ).toEqual({
    width: 2576,
    height: 939,
  });
});

test("maximized client constraints scale with DPI without rounding unchanged dimensions", () => {
  const frame = {
    width: 24,
    height: 59,
  };
  expect(
    constrainedOuterSize(2584, 1499, 144, frame, {
      minWidth: 600,
      minHeight: 400,
      maxWidth: 800,
      maxHeight: 600,
    }),
  ).toEqual({
    width: 1224,
    height: 959,
  });
  expect(constrainedOuterSize(825, 660, 144, frame, unconstrained)).toEqual({
    width: 825,
    height: 660,
  });
});
