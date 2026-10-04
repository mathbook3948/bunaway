import { createClient, createWebViewTransport } from "../../../packages/client-sdk/src/index.ts";

const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "memo-ui" },
});
const input = document.getElementById("memo");
const saved = document.getElementById("saved-memo");
const status = document.getElementById("status");
const button = document.getElementById("save");
const testPhase = new URL(location.href).searchParams.get("test");
window.addEventListener("pagehide", () => {
  void client.close();
});

async function start() {
  await client.ready;
  await client.listen(
    "memo.saved",
    (event) => {
      saved.textContent = event.payload;
      status.textContent = "저장 완료";
    },
    {
      onError: (error) => {
        status.textContent = `연결 오류: ${error.code}`;
      },
    },
  );
  try {
    input.value = await client.invoke("memo.read", null);
    saved.textContent = input.value;
    status.textContent = "저장된 메모를 불러왔습니다.";
  } catch (error) {
    status.textContent = `메모를 읽지 못했습니다: ${error.code}`;
  }
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await client.invoke("memo.save", input.value);
    } catch (error) {
      status.textContent = `저장 실패: ${error.code}`;
    } finally {
      button.disabled = false;
    }
  });
  // Integration package only: test.report is absent from the sample policy.
  if (testPhase === "write") {
    input.value = "재실행 후에도 남는 메모 😀";
    button.click();
    const deadline = Date.now() + 5000;
    while (button.disabled && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (testPhase === "read" || testPhase === "write") {
    await client.invoke("test.report", {
      file: `${testPhase}.json`,
      report: {
        page: "memo",
        results: [
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
  status.textContent = `연결 실패: ${error.code ?? "INTERNAL"}`;
});
