import {
  createClient,
  createWebViewTransport,
} from "../../../../../packages/client-sdk/src/index.ts";

const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: {
    kind: "hello",
    protocol: {
      major: 1,
      minor: 0,
    },
    features: [],
    buildId: "memo-ui",
  },
});
const input = document.getElementById("memo");
const saved = document.getElementById("saved-memo");
const statusEl = document.getElementById("status");
const button = document.getElementById("save");
const testPhase = new URL(location.href).searchParams.get("test");
const ephemeralBrowserStorage =
  new URL(location.href).searchParams.get("browserStorage") === "ephemeral";
let expectedEditorSave;
let resolveEditorSave;
window.addEventListener("pagehide", () => {
  void client.close();
});

async function waitForSaved() {
  const deadline = Date.now() + 5000;
  while (
    (button.disabled || saved.textContent !== input.value) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function start() {
  await client.ready;
  // Listen before loading so startup does not miss an early save event.
  await client.listen(
    "memo.saved",
    (event) => {
      saved.textContent = event.payload;
      statusEl.textContent = "저장 완료";
      if (event.payload === expectedEditorSave) {
        resolveEditorSave?.();
      }
    },
    {
      onError: (error) => {
        statusEl.textContent = `연결 오류: ${error.code}`;
      },
    },
  );
  try {
    input.value = await client.invoke("memo.read", null);
    saved.textContent = input.value;
    statusEl.textContent = "저장된 메모를 불러왔습니다.";
  } catch (error) {
    statusEl.textContent = `메모를 읽지 못했습니다: ${error.code}`;
  }
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await client.invoke("memo.save", input.value);
    } catch (error) {
      statusEl.textContent = `저장 실패: ${error.code}`;
    } finally {
      button.disabled = false;
    }
  });
  // Integration package only: test.report is absent from the sample policy.
  if (testPhase === "write") {
    input.value = "재실행 후에도 남는 메모 😀";
    button.click();
    await waitForSaved();
    localStorage.setItem("bunaway-profile-regression", "legacy-profile");
  }
  if (testPhase === "editor") {
    // Multi-view integration: the writable memo view saves, observes its own
    // memo.saved broadcast and reports so the reader view's assertions can run.
    const editorResults = [];
    try {
      input.value = "편집 뷰가 저장한 메모 ✏️";
      expectedEditorSave = input.value;
      const savedEvent = new Promise((resolve) => {
        resolveEditorSave = resolve;
      });
      await client.invoke("memo.save", input.value);
      await Promise.race([
        savedEvent,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("memo.saved event was not delivered")),
            5000,
          ),
        ),
      ]);
      editorResults.push({
        name: "editor save broadcasts to subscribed views",
        ok: saved.textContent === input.value,
      });
      editorResults.push({
        name: "editor reads back shared storage",
        ok: (await client.invoke("memo.read", null)) === input.value,
      });
    } catch (error) {
      editorResults.push({
        name: "editor save",
        ok: false,
        error: String(error?.message ?? error),
      });
    } finally {
      expectedEditorSave = undefined;
      resolveEditorSave = undefined;
    }
    await client.invoke("test.report", {
      file: "editor.json",
      report: {
        page: "editor",
        results: editorResults,
      },
    });
  }
  if (testPhase === "read" || testPhase === "write") {
    await client.invoke("test.report", {
      file: `${testPhase}.json`,
      report: {
        page: "memo",
        results: [
          {
            name: ephemeralBrowserStorage
              ? "ephemeral browser storage is cleared across restart"
              : "legacy browser profile storage persists across restart",
            ok:
              localStorage.getItem("bunaway-profile-regression") ===
              (ephemeralBrowserStorage && testPhase === "read"
                ? null
                : "legacy-profile"),
          },
          {
            name:
              testPhase === "write"
                ? "memo button saves and event refreshes screen"
                : "memo read after process restart",
            ok:
              input.value === "재실행 후에도 남는 메모 😀" &&
              saved.textContent === input.value &&
              !button.disabled,
          },
        ],
      },
    });
  }
}
start().catch((error) => {
  statusEl.textContent = `연결 실패: ${error.code ?? "INTERNAL"}`;
});
