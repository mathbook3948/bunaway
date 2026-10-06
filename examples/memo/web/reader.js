// Read-only memo view: watches memo.saved and re-reads shared storage. Its
// policy has no memo.save command and only read access to appData/notes.
import { createClient, createWebViewTransport } from "../../../packages/client-sdk/src/index.ts";

const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "memo-reader" },
});
const saved = document.getElementById("saved-memo");
const statusEl = document.getElementById("status");
const trySave = document.getElementById("try-save");
let connected = false;
function setStatus(message, state = "") {
  statusEl.textContent = message;
  statusEl.dataset.state = state;
}
window.addEventListener("pagehide", () => {
  void client.close();
});

async function start() {
  await client.ready;
  await client.listen(
    "memo.saved",
    (event) => {
      saved.textContent = event.payload;
      setStatus("편집 창에서 저장한 메모를 반영했어요.", "saved");
    },
    {
      onError: () => {
        connected = false;
        trySave.disabled = true;
        setStatus("연결이 끊어졌어요. 앱을 다시 열어주세요.", "error");
      },
    },
  );
  connected = true;
  try {
    saved.textContent = await client.invoke("memo.read", null);
    setStatus("저장된 메모를 불러왔어요.", "saved");
  } catch {
    setStatus("메모를 불러오지 못했어요.", "error");
  }
  trySave.disabled = !connected;
  trySave.addEventListener("click", async () => {
    try {
      await client.invoke("memo.save", "읽기 전용 뷰에서 쓴 메모");
      setStatus("읽기 전용 창에서 저장됐어요. 권한 설정을 확인해주세요.", "error");
    } catch (error) {
      setStatus(
        error.code === "PERMISSION_DENIED"
          ? "읽기 전용이라 메모를 저장할 수 없어요."
          : "저장하지 못했어요.",
        error.code === "PERMISSION_DENIED" ? "" : "error",
      );
    }
  });
}
start().catch(() => {
  setStatus("메모를 연결하지 못했어요. 앱을 다시 열어주세요.", "error");
});
