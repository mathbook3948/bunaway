import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { createOperations } from "#plugins/opener/src/windows";

if (
  process.platform !== "win32" ||
  process.env.BUNAWAY_OPENER_BROWSER_TEST !== "1" ||
  process.env.BUNAWAY_OPENER_ISOLATED !== "1"
) {
  throw new Error(
    "Run only in a disposable Windows Sandbox with BUNAWAY_OPENER_BROWSER_TEST=1 and BUNAWAY_OPENER_ISOLATED=1.",
  );
}

const ole = dlopen("ole32.dll", {
  CoInitializeEx: {
    args: [
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  CoGetApartmentType: {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  CoUninitialize: {
    args: [],
    returns: "void",
  },
});
let initialized = false;
let server: ReturnType<typeof Bun.serve> | undefined;
let adapter: ReturnType<typeof createOperations> | undefined;
try {
  // The Explorer adapter uses COM on this thread, so verify its STA before launch.
  const initResult = ole.symbols.CoInitializeEx(null, 0x2 | 0x4);
  assert(initResult >= 0);
  initialized = true;
  const apartment = new Uint32Array(1);
  const qualifier = new Uint32Array(1);
  assert.equal(
    ole.symbols.CoGetApartmentType(ptr(apartment), ptr(qualifier)),
    0,
  );
  const apartmentType = apartment[0];
  assert(
    apartmentType === 0 || apartmentType === 3,
    "The browser test must run in an STA.",
  );

  const nonce = crypto.randomUUID();
  let resolveRequest!: (requestUrl: URL) => void;
  let rejectRequest!: (error: Error) => void;
  const requestSeen = new Promise<URL>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const requestUrl = new URL(request.url);
      if (requestUrl.searchParams.get("run") === nonce) {
        resolveRequest(requestUrl);
        return new Response("Bunaway opener browser test");
      }
      return new Response("Not found", {
        status: 404,
      });
    },
  });
  const port = server.port;
  assert(port !== undefined);
  const opener = createOperations({
    dataRoot: process.cwd(),
    capabilities: [],
  });
  adapter = opener;
  assert(opener.executeUI);
  const url = new URL(`/open ${"한글"}`, `http://127.0.0.1:${port}`);
  url.search = new URLSearchParams({
    q: "space and 한글",
    run: nonce,
  }).toString();
  const inputUrl = `http://127.0.0.1:${port}/open 한글?q=space and 한글&run=${nonce}`;

  // The nonce ties the loopback request to this invocation of the default browser.
  assert.equal(
    await opener.executeUI(
      "opener.openUrl",
      {
        url: inputUrl,
      },
      "backend",
      {
        requestId: `browser-${nonce}`,
        permissions: {
          permissions: [
            "opener:openUrl",
          ],
        },
      },
    ),
    null,
    "A successful result means Windows accepted the request, not that the page loaded.",
  );

  const timeout = setTimeout(
    () =>
      rejectRequest(
        new Error("The default browser did not request the loopback page."),
      ),
    15000,
  );
  try {
    const requested = await requestSeen;
    assert.equal(requested.pathname, url.pathname);
    assert.equal(requested.searchParams.get("q"), "space and 한글");
    assert.equal(requested.searchParams.get("run"), nonce);
  } finally {
    clearTimeout(timeout);
  }
  console.log("PASS isolated default-browser loopback request");
} finally {
  await adapter?.dispose();
  server?.stop(true);
  if (initialized) {
    ole.symbols.CoUninitialize();
  }
  ole.close();
}
