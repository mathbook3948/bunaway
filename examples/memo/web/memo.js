import { createClient, createWebViewTransport } from "../../../packages/client-sdk/src/index.ts";

const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "memo-ui" },
});
const input = document.getElementById("memo");
const saved = document.getElementById("saved-memo");
const statusEl = document.getElementById("status");
const button = document.getElementById("save");
const count = document.getElementById("memo-count");
const saveLabel = document.getElementById("save-label");
let connected = false;
let saving = false;
function setStatus(message, state = "") {
  statusEl.textContent = message;
  statusEl.dataset.state = state;
}
function updateCount() {
  if (count) count.textContent = `${input.value.length.toLocaleString("ko-KR")} / 10,000자`;
}
input.addEventListener("input", () => {
  updateCount();
  if (connected && !saving) {
    const dirty = input.value !== saved.textContent;
    setStatus(
      dirty ? "아직 저장하지 않은 변경사항이 있어요." : "저장된 메모와 같아요.",
      dirty ? "dirty" : "saved",
    );
  }
});
if (navigator.platform.startsWith("Mac")) {
  const shortcut = document.getElementById("shortcut");
  if (shortcut) shortcut.textContent = "⌘ + S로 저장";
}
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!button.disabled) button.click();
  }
});
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
  while ((button.disabled || saved.textContent !== input.value) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
}

async function start() {
  await client.ready;
  await client.listen(
    "memo.saved",
    (event) => {
      saved.textContent = event.payload;
      setStatus(
        input.value === event.payload
          ? "메모를 저장했어요."
          : "저장된 메모가 업데이트됐어요. 작성 중인 내용은 그대로예요.",
        input.value === event.payload ? "saved" : "dirty",
      );
      if (event.payload === expectedEditorSave) resolveEditorSave?.();
    },
    {
      onError: () => {
        connected = false;
        button.disabled = true;
        setStatus("연결이 끊어졌어요. 메모를 저장하려면 앱을 다시 열어주세요.", "error");
      },
    },
  );
  connected = true;
  try {
    input.value = await client.invoke("memo.read", null);
    saved.textContent = input.value;
    updateCount();
    setStatus("저장된 메모를 불러왔어요.", "saved");
  } catch {
    setStatus("메모를 불러오지 못했어요. 새 메모는 작성할 수 있어요.", "error");
  }
  button.disabled = !connected;
  button.addEventListener("click", async () => {
    button.disabled = true;
    saving = true;
    updateCount();
    const value = input.value;
    let success = false;
    if (saveLabel) saveLabel.textContent = "저장 중…";
    setStatus("메모를 저장하고 있어요.");
    try {
      await client.invoke("memo.save", value);
      success = true;
    } catch {
      setStatus("저장하지 못했어요. 작성한 내용은 그대로예요.", "error");
    } finally {
      saving = false;
      button.disabled = !connected;
      if (saveLabel) saveLabel.textContent = "메모 저장";
      if (success && input.value !== value)
        setStatus("아직 저장하지 않은 변경사항이 있어요.", "dirty");
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
          setTimeout(() => reject(new Error("memo.saved event was not delivered")), 5000),
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
      report: { page: "editor", results: editorResults },
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
              (ephemeralBrowserStorage && testPhase === "read" ? null : "legacy-profile"),
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
start().catch(() => {
  setStatus("메모를 연결하지 못했어요. 앱을 다시 열어주세요.", "error");
});
