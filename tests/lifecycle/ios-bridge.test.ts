import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createWebViewTransport, type WebViewBridge } from "@bunaway/client";
import { PROTOCOL_VERSION } from "@bunaway/protocol";
import { frameworkRoot } from "#cli/files";
import { mobileBridge } from "#cli/mobile-project";

const portPrefix = "@bunaway-port:";
const nonce = "a611b10a-a5c2-444e-a694-fc17c5f884b4";
const hello = JSON.stringify({
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "fixture",
});

async function iosBridge() {
  const native: {
    nonce: string;
    data: string;
  }[] = [];
  let reloads = 0;
  let pagehide = () => {};
  let pageshow = (_event: { persisted: boolean }) => {};
  const context = {
    chrome: {
      webview: undefined as WebViewBridge | undefined,
    },
    webkit: {
      messageHandlers: {
        bunaway: {
          postMessage: (body: { nonce: string; data: string }) =>
            native.push(body),
        },
      },
    },
    addEventListener: (name: string, listener: typeof pageshow) => {
      if (name === "pageshow") {
        pageshow = listener;
      }
      if (name === "pagehide") {
        pagehide = () =>
          listener({
            persisted: false,
          });
      }
    },
    removeEventListener: () => {},
    location: {
      reload: () => {
        reloads++;
      },
    },
    __bunawayReceive: undefined as
      | ((nonce: string, data: string) => void)
      | undefined,
    __bunawayClose: undefined as ((nonce: string) => void) | undefined,
  };
  const source = await mobileBridge(frameworkRoot, "ios");
  runInNewContext(
    source
      .replaceAll("__BUNAWAY_DOCUMENT_NONCE__", nonce)
      .replaceAll("__BUNAWAY_PORT_PREFIX__", portPrefix),
    context,
  );
  const bridge = context.chrome.webview;
  const receive = context.__bunawayReceive;
  const close = context.__bunawayClose;
  if (!bridge || !receive || !close) {
    throw new Error("Missing iOS bridge.");
  }
  return {
    bridge,
    native,
    pagehide: () => pagehide(),
    receive,
    close,
    pageshow: (persisted: boolean) =>
      pageshow({
        persisted,
      }),
    reloads: () => reloads,
  };
}

test("iOS bridge isolates stale documents and closes the SDK once", async () => {
  const view = await iosBridge();
  const transport = createWebViewTransport(view.bridge);
  const events: string[] = [];
  transport.subscribe((event) => events.push(event.kind));
  await transport.send(hello);
  expect(view.native).toEqual([
    {
      nonce,
      data: portPrefix + nonce,
    },
  ]);
  view.receive("stale", `${portPrefix}fallback:${nonce}`);
  expect(view.native).toHaveLength(1);
  view.receive(nonce, `${portPrefix}fallback:${nonce}`);
  expect(view.native).toEqual([
    {
      nonce,
      data: portPrefix + nonce,
    },
    {
      nonce,
      data: hello,
    },
  ]);
  view.receive("stale", hello);
  view.close("stale");
  view.receive(nonce, hello);
  expect(events).toEqual([
    "message",
  ]);
  view.close(nonce);
  view.close(nonce);
  view.receive(nonce, hello);
  expect(events).toEqual([
    "message",
    "closed",
  ]);
  await expect(transport.send(hello)).rejects.toThrow("closed");
  await transport.close();
});

test("iOS cached pages reload their closed bridge while normal pageshow keeps it", async () => {
  const view = await iosBridge();
  view.pageshow(false);
  expect(view.reloads()).toBe(0);
  view.pagehide();
  view.pageshow(true);
  expect(view.reloads()).toBe(1);
});
