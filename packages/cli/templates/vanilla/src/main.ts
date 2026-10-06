import { createClient, createWebViewTransport, type WebViewBridge } from "@bunaway/client";

const bridge = (window as unknown as { chrome: { webview: WebViewBridge } }).chrome.webview;
const client = createClient({
  transport: createWebViewTransport(bridge),
  hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "vanilla-ui" },
});
const input = document.querySelector<HTMLTextAreaElement>("#message");
const saved = document.querySelector<HTMLElement>("#saved");
const status = document.querySelector<HTMLElement>("#status");
const button = document.querySelector<HTMLButtonElement>("#save");
if (!input || !saved || !status || !button) throw new Error("Missing UI elements.");
const ui = { input, saved, status, button };
let sessionEnded = false;

window.addEventListener("pagehide", () => {
  void client.close();
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function start(): Promise<void> {
  await client.ready;
  await client.listen(
    "message.saved",
    (event) => {
      ui.saved.textContent = String(event.payload);
      ui.status.textContent = "Saved. Screen updated by message.saved event.";
    },
    {
      onError: () => {
        sessionEnded = true;
        ui.button.disabled = true;
        ui.status.textContent = "Session ended. Requests will not be replayed.";
      },
    },
  );
  try {
    const text = String(await client.invoke("message.read", null));
    ui.input.value = text;
    ui.saved.textContent = text;
    ui.status.textContent = "Loaded from appData/messages/current.txt";
  } catch (error) {
    ui.status.textContent = `No saved message yet, or read failed: ${errorText(error)}`;
  }
  ui.button.disabled = sessionEnded;
  ui.button.addEventListener("click", async () => {
    ui.button.disabled = true;
    try {
      await client.invoke("message.save", ui.input.value);
    } catch (error) {
      ui.status.textContent = `Save failed (not retried): ${errorText(error)}`;
    } finally {
      ui.button.disabled = sessionEnded;
    }
  });
}

void start().catch((error) => {
  ui.status.textContent = `Connection failed: ${errorText(error)}`;
});
