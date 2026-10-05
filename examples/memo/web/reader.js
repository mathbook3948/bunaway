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
window.addEventListener("pagehide", () => {
  void client.close();
});

async function start() {
  await client.ready;
  await client.listen(
    "memo.saved",
    (event) => {
      saved.textContent = event.payload;
      statusEl.textContent = "편집 뷰의 저장을 반영했습니다.";
    },
    {
      onError: (error) => {
        statusEl.textContent = `연결 오류: ${error.code}`;
      },
    },
  );
  try {
    saved.textContent = await client.invoke("memo.read", null);
    statusEl.textContent = "저장된 메모를 불러왔습니다.";
  } catch (error) {
    statusEl.textContent = `메모를 읽지 못했습니다: ${error.code}`;
  }
  trySave.disabled = false;
  trySave.addEventListener("click", async () => {
    try {
      await client.invoke("memo.save", "읽기 전용 뷰에서 쓴 메모");
      statusEl.textContent = "저장됨 (예상 밖)";
    } catch (error) {
      statusEl.textContent = `저장 거부됨: ${error.code}`;
    }
  });
}
start().catch((error) => {
  statusEl.textContent = `연결 실패: ${error.code ?? "INTERNAL"}`;
});
