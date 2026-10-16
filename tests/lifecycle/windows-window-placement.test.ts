import { expect, test } from "bun:test";
import {
  MAX_WINDOW_COORDINATE,
  MIN_WINDOW_COORDINATE,
} from "@bunaway/plugin-api/native";
import {
  centerInWorkArea,
  initialWindowPlacement,
  selectMonitorWorkArea,
} from "#native/windows/bun/window-placement";
import { logicalPixels, physicalPixels } from "#native/windows/bun/window-size";

const work = {
  x: -1920,
  y: -100,
  width: 1920,
  height: 1040,
};
const frame = {
  width: 16,
  height: 39,
};
const defaults = {
  width: 800,
  height: 600,
};

test("initial HWND placement reconciles mixed DPI without changing the selected work area", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `${import.meta.dir}/windows-initial-placement.fixture.ts`,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("initial placement preserves OS-default position, signed physical coordinates and outer centering", () => {
  expect(initialWindowPlacement(defaults, 96, frame, work)).toEqual({
    content: defaults,
    outer: {
      width: 816,
      height: 639,
    },
    position: undefined,
  });
  expect(
    initialWindowPlacement(
      {
        ...defaults,
        x: -1900,
        y: -90,
      },
      144,
      frame,
      work,
    ).position,
  ).toEqual({
    x: -1900,
    y: -90,
  });
  expect(centerInWorkArea(work, 815, 639)).toEqual({
    x: -1367,
    y: 101,
  });
  expect(
    initialWindowPlacement(
      {
        ...defaults,
        center: true,
      },
      96,
      frame,
      work,
    ).position,
  ).toEqual(centerInWorkArea(work, 816, 639));
  expect(
    initialWindowPlacement(
      {
        ...defaults,
        width: 4096,
        center: true,
      },
      96,
      frame,
      work,
    ).position?.x,
  ).toBeLessThan(work.x);
});

test.each([
  96,
  120,
  144,
  192,
])(
  "initial content and outer size reuse the logical conversion and constraints at DPI %s",
  (dpi) => {
    const scaledFrame = {
      width: physicalPixels(16, dpi),
      height: physicalPixels(39, dpi),
    };
    const content = initialWindowPlacement(defaults, dpi, scaledFrame, work);
    expect(content.outer.width).toBe(
      physicalPixels(800, dpi) + scaledFrame.width,
    );
    const outer = initialWindowPlacement(
      {
        ...defaults,
        useContentSize: false,
      },
      dpi,
      scaledFrame,
      work,
    );
    expect(outer.content.width).toBe(
      logicalPixels(physicalPixels(800, dpi) - scaledFrame.width, dpi),
    );
    expect(outer.outer.width).toBe(physicalPixels(800, dpi));
    const constrained = initialWindowPlacement(
      {
        ...defaults,
        useContentSize: false,
        minWidth: 800,
        maxHeight: 400,
      },
      dpi,
      scaledFrame,
      work,
    );
    expect(constrained.content).toEqual({
      width: 800,
      height: 400,
    });
  },
);

test.each([
  96,
  120,
  144,
  192,
])(
  "overflow fitting stays within physical work bounds after rounding at DPI %s",
  (dpi) => {
    const area = {
      x: -1000,
      y: 40,
      width: 1001,
      height: 703,
    };
    const options = {
      width: 4096,
      height: 4096,
      preventOverflow: true,
      x: 2000,
      y: -3000,
    };
    const plan = initialWindowPlacement(options, dpi, frame, area);
    expect(plan.outer.width).toBeLessThanOrEqual(area.width);
    expect(plan.outer.height).toBeLessThanOrEqual(area.height);
    expect(plan.position).toEqual({
      x: area.x + area.width - plan.outer.width,
      y: area.y,
    });
    const centered = initialWindowPlacement(
      {
        ...options,
        x: null,
        y: null,
        center: true,
      },
      dpi,
      frame,
      area,
    );
    expect(centered.position).toEqual(
      centerInWorkArea(area, centered.outer.width, centered.outer.height),
    );
    expect(
      initialWindowPlacement(
        {
          ...defaults,
          preventOverflow: true,
        },
        dpi,
        frame,
        work,
      ).position,
    ).toEqual({
      x: work.x,
      y: work.y,
    });
  },
);

test("overflow preserves min/max constraints, rejects impossible minima and allows oversized windows when disabled", () => {
  const options = {
    ...defaults,
    minWidth: 800,
    minHeight: 600,
    preventOverflow: true,
  };
  expect(
    initialWindowPlacement(options, 96, frame, {
      ...work,
      width: 816,
      height: 639,
    }).content,
  ).toEqual(defaults);
  for (const area of [
    {
      ...work,
      width: 815,
    },
    {
      ...work,
      height: 638,
    },
    {
      ...work,
      width: 16,
    },
  ]) {
    expect(() => initialWindowPlacement(options, 96, frame, area)).toThrow(
      "cannot fit",
    );
  }
  expect(
    initialWindowPlacement(
      {
        ...defaults,
        width: 4096,
      },
      96,
      frame,
      work,
    ).outer.width,
  ).toBe(4112);
  expect(
    initialWindowPlacement(
      {
        ...defaults,
        maxWidth: 300,
        maxHeight: 400,
        preventOverflow: true,
      },
      96,
      frame,
      work,
    ).content,
  ).toEqual({
    width: 300,
    height: 400,
  });
  expect(
    initialWindowPlacement(
      {
        ...defaults,
        preventOverflow: true,
      },
      96,
      frame,
      {
        ...work,
        width: 17,
        height: 40,
      },
    ).content,
  ).toEqual({
    width: 1,
    height: 1,
  });
});

test("initial rectangles reject signed coordinate overflow without treating CW_USEDEFAULT as an omitted coordinate", () => {
  expect(
    initialWindowPlacement(
      {
        ...defaults,
        x: MIN_WINDOW_COORDINATE,
        y: 0,
      },
      96,
      frame,
      work,
    ).position?.x,
  ).toBe(MIN_WINDOW_COORDINATE);
  expect(() =>
    initialWindowPlacement(
      {
        ...defaults,
        x: MAX_WINDOW_COORDINATE,
        y: 0,
      },
      96,
      frame,
      work,
    ),
  ).toThrow("coordinate range");
  expect(() =>
    initialWindowPlacement(
      {
        ...defaults,
        x: 0,
        y: MAX_WINDOW_COORDINATE,
      },
      96,
      frame,
      work,
    ),
  ).toThrow("coordinate range");
});

test("an 8K work area at 100 percent scaling accepts the largest content minimum", () => {
  const area = {
    x: 0,
    y: 0,
    width: 7680,
    height: 4280,
  };
  const plan = initialWindowPlacement(
    {
      width: 4096,
      height: 4096,
      minWidth: 4096,
      minHeight: 4096,
      preventOverflow: true,
    },
    96,
    frame,
    area,
  );
  expect(plan.content).toEqual({
    width: 4096,
    height: 4096,
  });
  expect(plan.outer.width).toBeLessThanOrEqual(area.width);
  expect(plan.outer.height).toBeLessThanOrEqual(area.height);
});

const leftMonitor = {
  id: "\\\\.\\DISPLAY2",
  workArea: work,
};
const primaryMonitor = {
  id: "\\\\.\\DISPLAY1",
  workArea: {
    x: 0,
    y: 0,
    width: 2560,
    height: 1400,
  },
};
const topMonitor = {
  id: "\\\\.\\DISPLAY3",
  workArea: {
    x: 0,
    y: -1080,
    width: 1920,
    height: 1040,
  },
};
const monitors = [
  primaryMonitor,
  leftMonitor,
  topMonitor,
];

test("runtime center selects the exact monitor work area including negative origins", () => {
  expect(selectMonitorWorkArea(monitors, leftMonitor.id)).toEqual(work);
  expect(selectMonitorWorkArea(monitors, topMonitor.id)).toEqual(
    topMonitor.workArea,
  );
  expect(selectMonitorWorkArea(monitors, primaryMonitor.id)).toEqual(
    primaryMonitor.workArea,
  );
  expect(
    centerInWorkArea(selectMonitorWorkArea(monitors, leftMonitor.id), 816, 639),
  ).toEqual({
    x: -1368,
    y: 101,
  });
  expect(
    centerInWorkArea(selectMonitorWorkArea(monitors, topMonitor.id), 816, 639),
  ).toEqual({
    x: 552,
    y: -879,
  });
});

test("runtime center rejects unknown monitors without falling back", () => {
  for (const monitorId of [
    "\\\\.\\DISPLAY999",
    "\\\\.\\display1",
    "",
  ]) {
    let failure: unknown;
    try {
      selectMonitorWorkArea(monitors, monitorId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(() => selectMonitorWorkArea([], primaryMonitor.id)).toThrow();
});

test("runtime center recenters a DPI-changed outer size in the same selected work area", () => {
  const area = selectMonitorWorkArea(monitors, primaryMonitor.id);
  // The window is first centered with its pre-move 96 DPI size, then once more with the
  // size the OS-suggested rectangle produced at 144 DPI.
  expect(centerInWorkArea(area, 816, 639)).toEqual({
    x: 872,
    y: 381,
  });
  expect(centerInWorkArea(area, 1224, 958)).toEqual({
    x: 668,
    y: 221,
  });
});
