import {
  createClient,
  createWebViewTransport,
} from "../../../../../packages/client-sdk/src/index.ts";

const params = new URLSearchParams(location.search);
const results = [];
const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: {
    kind: "hello",
    protocol: { major: 1, minor: 0 },
    features: [],
    buildId: "macos-security-ui",
  },
});

async function test(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error) });
  }
}

function loadElement(kind, url) {
  return new Promise((resolve, reject) => {
    const element = document.createElement(kind);
    const timer = setTimeout(() => {
      element.remove();
      reject(new Error(`Timed out loading ${kind}: ${url}`));
    }, 5000);
    const finish = (loaded) => {
      clearTimeout(timer);
      element.remove();
      resolve(loaded);
    };
    element.onload = () => finish(true);
    element.onerror = () => finish(false);
    element.src = url;
    document.body.append(element);
  });
}

await client.ready;
for (const kind of ["script", "img", "fetch"]) {
  for (const allowed of [true, false]) {
    await test(`${kind} ${allowed ? "allowed" : "blocked"} by destination origin`, async () => {
      const base = params.get(allowed ? "allowed" : "blocked");
      const url = `${base}/${kind}`;
      let loaded;
      if (kind === "fetch") {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          loaded = response.ok && (await response.text()) === "resource-ok";
        } catch (error) {
          if (error.name === "TimeoutError") throw error;
          loaded = false;
        }
      } else {
        loaded = await loadElement(kind, url);
      }
      if (loaded !== allowed) throw new Error(`Unexpected load result: ${url}`);
    });
  }
}

for (const command of ["test.tempRead", "test.tempWrite"]) {
  await test(`${command} rejects FIFO without a peer`, async () => {
    const outcome = await client.invoke(command, { path: "pipe", text: "forbidden" });
    if (outcome.ok || outcome.code !== "PERMISSION_DENIED")
      throw new Error(`Unexpected FIFO outcome: ${JSON.stringify(outcome)}`);
  });
}

await client.invoke("test.report", {
  file: "security.json",
  report: { page: "security", results },
});
