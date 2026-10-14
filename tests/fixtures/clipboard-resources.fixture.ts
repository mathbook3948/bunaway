import assert from "node:assert/strict";
import { type JsonValue, validateValue } from "@bunaway/protocol";
import {
  MAX_BINARY_BYTES,
  MAX_BINARY_FORMATS,
  MAX_BOOKMARK_LENGTH,
} from "#plugins/clipboard/src/contract";
import createOperationsDefinition from "#plugins/clipboard/src/index";
import { createClipboard } from "#plugins/clipboard/src/platforms/windows-bindings";
import {
  encodeBinary,
  encodeHTML,
  MAX_NATIVE_FORMAT_BYTES,
} from "#plugins/clipboard/src/platforms/windows-codecs";
import { state } from "./clipboard-ffi.ts";
import { nativeFactory as createOperationsFactory } from "./native-platform.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

const environment = {
  dataRoot: ".",
  capabilities: [],
};
const context = {
  requestId: "test",
  permissions: {
    permissions: [
      "clipboard.readText",
      "clipboard.writeText",
      "clipboard.clear",
      "clipboard.readImage",
      "clipboard.writeImage",
      "clipboard.getFormats",
      "clipboard.hasFormat",
      "clipboard.readFormats",
      "clipboard.writeFormats",
    ],
  },
};
const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;

for (const failure of [
  "kernel32.dll",
  "create",
]) {
  state.fail = failure;
  assert.throws(createClipboard);
  assert.equal(state.libraries, 0);
  assert.equal(state.windows, 0);
}
state.fail = "";
const unclosed = createClipboard();
assert.equal(unclosed.open(), true);
state.fail = "close";
assert.throws(() => unclosed.close(), hasCode("INTERNAL"));
assert.throws(() => unclosed.open(), hasCode("INTERNAL"));
state.fail = "";
unclosed.dispose();
assert.equal(state.opened, false);
assert.equal(state.windows, 0);
assert.equal(state.libraries, 0);
const adapter = createOperations(environment);
assert(adapter.executeUI);
const execute = (name: string, input: JsonValue = null, signal?: AbortSignal) =>
  adapter.executeUI?.(`clipboard.${name}`, input, "backend", {
    ...context,
    ...(signal
      ? {
          signal,
        }
      : {}),
  });

await assert.rejects(
  async () =>
    adapter.executeUI?.("clipboard.clear", null, "backend", {
      ...context,
      permissions: {
        permissions: [
          "clipboard.writeText",
        ],
      },
    }),
  hasCode("PERMISSION_DENIED"),
);
await assert.rejects(async () => execute("missing"), hasCode("UNSUPPORTED"));
await assert.rejects(
  async () =>
    execute("writeText", {
      text: "bad\0text",
    }),
  hasCode("INVALID_ARGUMENT"),
);
assert.equal(state.clears, 0);
// Reject excessive UTF-16 units before allocating or replacing the existing clipboard.
const bookmarkPrefix = "https://example.com/";
const remainingBookmarkUnits = MAX_BOOKMARK_LENGTH - bookmarkPrefix.length;
const maximumBookmarkURL = `${bookmarkPrefix}${"😀".repeat(Math.floor(remainingBookmarkUnits / 2))}${"x".repeat(remainingBookmarkUnits % 2)}`;
const beforeBookmarkClears: number = state.clears;
const beforeBookmarkAllocations = state.allocationCalls;
const originalBookmarkData = state.data;
for (const url of [
  `${maximumBookmarkURL}x`,
  `${bookmarkPrefix}${"😀".repeat(1024)}`,
]) {
  await assert.rejects(
    async () =>
      execute("writeFormats", {
        items: [
          {
            format: "text/plain",
            data: "must not replace previous text",
          },
          {
            format: "application/x-bunaway-bookmark",
            data: {
              url,
            },
          },
        ],
      }),
    hasCode("INVALID_ARGUMENT"),
  );
  assert.equal(state.clears, beforeBookmarkClears);
  assert.equal(state.allocationCalls, beforeBookmarkAllocations);
  assert.equal(state.data, originalBookmarkData);
  assert.equal(state.opened, false);
}
assert.equal(await execute("readText"), "old");

for (const failure of [
  "alloc",
  "lock",
  "empty",
  "set",
]) {
  state.fail = failure;
  const clears: number = state.clears;
  const frees = state.frees;
  await assert.rejects(
    async () =>
      execute("writeText", {
        text: "new 😀",
      }),
    hasCode("INTERNAL"),
  );
  assert.equal(state.opened, false);
  assert.equal(state.locks, 0);
  assert.equal(state.allocations.size, 0);
  assert.equal(state.frees - frees, failure === "alloc" ? 0 : 1);
  assert.equal(state.clears - clears, failure === "set" ? 1 : 0);
}
state.fail = "";
const frees = state.frees;
await execute("writeText", {
  text: "한글 😀\n\r\n",
});
assert.equal(state.transferred, 1);
assert.equal(state.frees, frees);
assert.equal(await execute("readText"), "한글 😀\n\r\n");
assert.equal(state.locks, 0);
assert.equal(state.frees, frees, "Read handles belong to Windows");
await execute("writeText", {
  text: "",
});
assert.equal(await execute("readText"), "");
await execute("clear");
assert.equal(await execute("readText"), null);
state.format = true;
for (const bytes of [
  Buffer.from("unterminated", "utf16le"),
  Buffer.from([
    1,
  ]),
  Buffer.from("\ud800\0", "utf16le"),
  Buffer.alloc(70_000),
]) {
  state.data = bytes;
  await assert.rejects(async () => execute("readText"), hasCode("INTERNAL"));
  assert.equal(state.opened, false);
  assert.equal(state.locks, 0);
}
state.data = Buffer.from("old\0", "utf16le");
for (const failure of [
  "get",
  "lock",
]) {
  state.fail = failure;
  await assert.rejects(async () => execute("readText"), hasCode("INTERNAL"));
  assert.equal(state.opened, false);
}
state.fail = "";
state.fail = "register";
await assert.rejects(
  async () =>
    execute("hasFormat", {
      format: "text/html",
    }),
  hasCode("INTERNAL"),
);
state.fail = "";
const image = {
  width: 1,
  height: 1,
  rgba: "AQIDBA==",
};
const items = [
  {
    format: "text/plain",
    data: "fallback 한글",
  },
  {
    format: "text/html",
    data: "<b>한글 😀</b>",
  },
  {
    format: "text/rtf",
    data: "{\\rtf1 \\u54620?}",
  },
  {
    format: "application/x-bunaway-file-list",
    data: [
      "C:\\한글\\memo.txt",
    ],
  },
  {
    format: "image/bmp",
    data: image,
  },
];
await execute("writeFormats", {
  items,
});
assert.deepEqual(
  await execute("getFormats"),
  validateValue(
    {},
    items.map((item) => item.format),
  ),
);
assert.deepEqual(
  await execute("readFormats", {
    formats: items.map((item) => item.format),
  }),
  validateValue({}, items),
);
assert.deepEqual(await execute("readImage"), validateValue({}, image));
assert.equal(
  await execute("hasFormat", {
    format: "text/html",
  }),
  true,
);
assert.equal(state.opened, false);
assert.equal(state.locks, 0);
assert.equal(state.allocations.size, 0);
await execute("writeImage", image);
assert.equal(await execute("readText"), null);
assert.equal(
  await execute("hasFormat", {
    format: "text/html",
  }),
  false,
);
assert.deepEqual(
  await execute("readFormats", {
    formats: [
      "text/html",
      "image/bmp",
    ],
  }),
  validateValue({}, [
    {
      format: "text/html",
      data: null,
    },
    {
      format: "image/bmp",
      data: image,
    },
  ]),
);
// Partial preparation must preserve existing image data and free the first allocation.
state.failAtAllocation = state.allocationCalls + 2;
const beforePrepare = state.clears;
await assert.rejects(
  async () =>
    execute("writeFormats", {
      items,
    }),
  hasCode("INTERNAL"),
);
assert.equal(state.clears, beforePrepare);
assert.equal(state.allocations.size, 0);
assert.deepEqual(await execute("readImage"), validateValue({}, image));
state.failAtAllocation = 0;
// A failure after the first transfer preserves that Windows-owned format and frees the rest.
state.failAtSet = state.setCalls + 2;
const beforeTransfer = state.transferred;
const beforeFree = state.frees;
await assert.rejects(
  async () =>
    execute("writeFormats", {
      items,
    }),
  hasCode("INTERNAL"),
);
assert.equal(state.transferred, beforeTransfer + 1);
assert.equal(state.frees, beforeFree + 4);
assert.equal(state.allocations.size, 0);
assert.equal(await execute("readText"), items[0]?.data);
assert.equal(await execute("readImage"), null);
state.failAtSet = 0;
// Borrowed custom-format blocks must be copied, bounded and unlocked on decode failure.
const htmlId = state.registered.get("HTML Format");
assert(htmlId !== undefined);
for (const bytes of [
  Buffer.from("malformed"),
  Buffer.alloc(MAX_NATIVE_FORMAT_BYTES + 1),
]) {
  state.formats.set(htmlId, bytes);
  await assert.rejects(
    async () =>
      execute("readFormats", {
        formats: [
          "text/html",
        ],
      }),
    hasCode("INTERNAL"),
  );
  assert.equal(state.locks, 0);
  assert.equal(state.opened, false);
}
const external = encodeHTML("<b>external</b>");
state.formats.set(htmlId, external);
assert.deepEqual(
  await execute("readFormats", {
    formats: [
      "text/html",
    ],
  }),
  validateValue({}, [
    {
      format: "text/html",
      data: "<b>external</b>",
    },
  ]),
);
external.fill(0);
const extensions = [
  {
    format: "application/x-bunaway-bookmark",
    data: {
      url: "https://example.com/한글😀",
    },
  },
  {
    format: "application/x-bunaway-binary/memo",
    data: "AP+A/w==",
  },
  {
    format: "text/plain",
    data: "URL fallback",
  },
];
for (const [operation, input] of [
  [
    "readFormats",
    {
      formats: extensions.map((item) => item.format),
    },
  ],
  [
    "writeFormats",
    {
      items: extensions,
    },
  ],
  [
    "hasFormat",
    {
      format: "application/x-bunaway-bookmark",
    },
  ],
] as const) {
  await assert.rejects(
    async () =>
      adapter.executeUI?.(
        `clipboard.${operation}`,
        validateValue({}, input),
        "backend",
        {
          ...context,
          permissions: {
            permissions: [
              "clipboard.writeText",
            ],
          },
        },
      ),
    hasCode("PERMISSION_DENIED"),
  );
}
await execute(
  "writeFormats",
  validateValue(
    {},
    {
      items: extensions,
    },
  ),
);
assert.deepEqual(
  await execute("readFormats", {
    formats: extensions.map((item) => item.format),
  }),
  validateValue({}, extensions),
);
assert.deepEqual(await execute("getFormats"), [
  "text/plain",
  "application/x-bunaway-bookmark",
]);
for (const data of [
  "",
  Buffer.alloc(MAX_BINARY_BYTES, 255).toString("base64"),
]) {
  await execute("writeFormats", {
    items: [
      {
        format: "application/x-bunaway-binary/memo",
        data,
      },
    ],
  });
  assert.deepEqual(
    await execute("readFormats", {
      formats: [
        "application/x-bunaway-binary/memo",
      ],
    }),
    validateValue({}, [
      {
        format: "application/x-bunaway-binary/memo",
        data,
      },
    ]),
  );
}
for (const failure of [
  "alloc",
  "lock",
  "register",
  "empty",
  "set",
]) {
  await execute("writeText", {
    text: "preserve before extension failure",
  });
  const before: number = state.clears;
  const beforeFree = state.frees;
  state.fail = failure;
  // The new binary name makes registration failure observable after bookmark preparation.
  await assert.rejects(
    async () =>
      execute(
        "writeFormats",
        validateValue(
          {},
          {
            items: [
              extensions[0],
              {
                format: `application/x-bunaway-binary/failure-${failure}`,
                data: "AA==",
              },
            ],
          },
        ),
      ),
    hasCode("INTERNAL"),
  );
  state.fail = "";
  assert.equal(state.clears, before + (failure === "set" ? 1 : 0));
  assert.equal(state.allocations.size, 0);
  assert.equal(state.locks, 0);
  assert.equal(state.opened, false);
  let expectedFrees = 2;
  if (failure === "alloc") {
    expectedFrees = 0;
  } else if (failure === "lock" || failure === "register") {
    expectedFrees = 1;
  }
  assert.equal(state.frees - beforeFree, expectedFrees);
  if (failure !== "set") {
    assert.equal(
      await execute("readText"),
      "preserve before extension failure",
    );
  }
}
state.failAtSet = state.setCalls + 2;
const beforeExtensionFree = state.frees;
await assert.rejects(
  async () =>
    execute(
      "writeFormats",
      validateValue(
        {},
        {
          items: extensions,
        },
      ),
    ),
  hasCode("INTERNAL"),
);
state.failAtSet = 0;
assert.equal(state.frees, beforeExtensionFree + 2);
assert.deepEqual(
  await execute("readFormats", {
    formats: [
      "application/x-bunaway-bookmark",
      "application/x-bunaway-binary/memo",
    ],
  }),
  validateValue({}, [
    extensions[0],
    {
      format: "application/x-bunaway-binary/memo",
      data: null,
    },
  ]),
);
const binaryId = state.registered.get("application/x-bunaway-binary/memo");
const bookmarkId = state.registered.get("UniformResourceLocatorW");
assert(binaryId !== undefined && bookmarkId !== undefined);
for (const url of [
  "HTTPS://example.com/Path?Name=Value#Anchor",
  "HTTP://example.com/Path",
  "hTtPs://EXAMPLE.com/한글😀?a=%2F",
]) {
  const item = {
    format: "application/x-bunaway-bookmark",
    data: {
      url,
    },
  };
  await execute("writeFormats", {
    items: [
      item,
    ],
  });
  assert.deepEqual(
    await execute("readFormats", {
      formats: [
        item.format,
      ],
    }),
    validateValue({}, [
      item,
    ]),
  );
  // Install an independently encoded borrowed native block instead of using the plugin's encoder.
  const externalBookmark = Buffer.from(`${url}\0`, "utf16le");
  state.formats.set(bookmarkId, externalBookmark);
  const freesBeforeRead = state.frees;
  const externalResult = await execute("readFormats", {
    formats: [
      item.format,
    ],
  });
  externalBookmark.fill(0);
  assert.deepEqual(
    externalResult,
    validateValue({}, [
      item,
    ]),
  );
  assert.equal(state.frees, freesBeforeRead);
  assert.equal(state.opened, false);
  assert.equal(state.locks, 0);
}
for (const [format, id, malformed] of [
  [
    "application/x-bunaway-binary/memo",
    binaryId,
    [
      Buffer.alloc(11),
      Buffer.alloc(MAX_NATIVE_FORMAT_BYTES + 1),
      Buffer.from("BUNBIN01\x01\x00\x00\x00", "binary"),
    ],
  ],
  [
    "application/x-bunaway-bookmark",
    bookmarkId,
    [
      Buffer.from("https://example.com/", "utf16le"),
      Buffer.from("file:///C:/private\0", "utf16le"),
      Buffer.alloc(MAX_NATIVE_FORMAT_BYTES + 1),
    ],
  ],
] as const) {
  for (const bytes of malformed) {
    state.formats.set(id, bytes);
    const freesBeforeRead = state.frees;
    await assert.rejects(
      async () =>
        execute("readFormats", {
          formats: [
            format,
          ],
        }),
      hasCode("INTERNAL"),
    );
    assert.equal(state.frees, freesBeforeRead);
    assert.equal(state.opened, false);
    assert.equal(state.locks, 0);
  }
}
const externalBinary = encodeBinary("AP+A/w==");
state.formats.set(binaryId, externalBinary);
const copiedBinary = await execute("readFormats", {
  formats: [
    "application/x-bunaway-binary/memo",
  ],
});
externalBinary.fill(0);
assert.deepEqual(
  copiedBinary,
  validateValue({}, [
    {
      format: "application/x-bunaway-binary/memo",
      data: "AP+A/w==",
    },
  ]),
);
// The per-owner registration limit applies before clearing; existing names remain usable.
const alreadyRegistered = Array.from(state.registered.keys()).filter((name) =>
  name.startsWith("application/x-bunaway-binary/"),
).length;
for (let index = alreadyRegistered; index < MAX_BINARY_FORMATS; index++) {
  assert.equal(
    await execute("hasFormat", {
      format: `application/x-bunaway-binary/capacity-${index}`,
    }),
    false,
  );
}
const beforeCapacity = state.clears;
await assert.rejects(
  async () =>
    execute("writeFormats", {
      items: [
        {
          format: "text/plain",
          data: "prepared",
        },
        {
          format: "application/x-bunaway-binary/over-capacity",
          data: "",
        },
      ],
    }),
  hasCode("BUSY"),
);
assert.equal(state.clears, beforeCapacity);
assert.equal(state.allocations.size, 0);
await execute(
  "writeFormats",
  validateValue(
    {},
    {
      items: extensions,
    },
  ),
);
await execute("writeText", {
  text: "old",
});
state.occupied = true;
await assert.rejects(async () => execute("clear"), hasCode("BUSY"));
const clears = state.clears;
const controller = new AbortController();
const cancelled = execute("clear", null, controller.signal);
const allocationCallsBeforeCancel = state.allocationCalls;
setTimeout(() => controller.abort(), 15);
await assert.rejects(async () => cancelled, hasCode("CANCELLED"));
assert.equal(state.allocationCalls, allocationCallsBeforeCancel);
assert.equal(state.clears, clears);
const binaryController = new AbortController();
const binaryCancelled = execute(
  "writeFormats",
  validateValue(
    {},
    {
      items: extensions,
    },
  ),
  binaryController.signal,
);
setTimeout(() => binaryController.abort(), 15);
await assert.rejects(async () => binaryCancelled, hasCode("CANCELLED"));
assert.equal(state.allocationCalls, allocationCallsBeforeCancel);
assert.equal(state.clears, clears);
const afterRelease = execute("writeText", {
  text: "retry",
});
setTimeout(() => {
  state.occupied = false;
}, 15);
await afterRelease;
assert.equal(state.clears, clears + 1);
state.occupied = true;
const stopped = execute("clear");
await adapter.dispose();
await assert.rejects(async () => stopped, hasCode("CANCELLED"));
await adapter.dispose();
await assert.rejects(async () => execute("clear"), hasCode("CANCELLED"));
assert.equal(state.windows, 0);
assert.equal(state.libraries, 0);
assert.equal(state.allocations.size, 0);
assert.equal(state.locks, 0);
assert.equal(state.opened, false);
console.log(
  "clipboard ownership, failure, retry, cancellation and disposal passed",
);
