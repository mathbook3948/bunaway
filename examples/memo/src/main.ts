import type { CommandsOf, EventsOf } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
import type { memoApp } from "../src-bunaway/app.ts";

const input = document.querySelector<HTMLTextAreaElement>("#memo");
const saved = document.querySelector<HTMLElement>("#saved-memo");
const statusEl = document.querySelector<HTMLElement>("#status");
const button = document.querySelector<HTMLButtonElement>("#save");
const count = document.querySelector<HTMLElement>("#memo-count");
const saveLabel = document.querySelector<HTMLElement>("#save-label");
if (!input || !saved || !statusEl || !button || !count || !saveLabel) {
  throw new Error("Missing UI elements.");
}
const ui = {
  input,
  saved,
  statusEl,
  button,
  count,
  saveLabel,
};
let connected = false;
let saving = false;
function setStatus(message: string, state = "") {
  ui.statusEl.textContent = message;
  ui.statusEl.dataset.state = state;
}
function updateCount() {
  ui.count.textContent = `${ui.input.value.length.toLocaleString("ko-KR")} / 10,000자`;
}
ui.input.addEventListener("input", () => {
  updateCount();
  if (connected && !saving) {
    const dirty = ui.input.value !== ui.saved.textContent;
    setStatus(
      dirty ? "아직 저장하지 않은 변경사항이 있어요." : "저장된 메모와 같아요.",
      dirty ? "dirty" : "saved",
    );
  }
});
if (navigator.platform.startsWith("Mac")) {
  const shortcut = document.getElementById("shortcut");
  if (shortcut) {
    shortcut.textContent = "⌘ + S로 저장";
  }
}
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    if (!ui.button.disabled) {
      ui.button.click();
    }
  }
});

async function start() {
  const client = createClient<
    CommandsOf<typeof memoApp>,
    EventsOf<typeof memoApp>
  >();
  await client.listen(
    "memo.saved",
    (event) => {
      const text = event.payload;
      ui.saved.textContent = text;
      setStatus(
        ui.input.value === text
          ? "메모를 저장했어요."
          : "저장된 메모가 업데이트됐어요. 작성 중인 내용은 그대로예요.",
        ui.input.value === text ? "saved" : "dirty",
      );
    },
    {
      onError: () => {
        connected = false;
        ui.button.disabled = true;
        setStatus(
          "연결이 끊어졌어요. 메모를 저장하려면 앱을 다시 열어주세요.",
          "error",
        );
      },
    },
  );
  connected = true;
  try {
    ui.input.value = await client.invoke("memo.read", null);
    ui.saved.textContent = ui.input.value;
    updateCount();
    setStatus("저장된 메모를 불러왔어요.", "saved");
  } catch {
    setStatus("메모를 불러오지 못했어요. 새 메모는 작성할 수 있어요.", "error");
  }
  ui.button.disabled = !connected;
  ui.button.addEventListener("click", async () => {
    ui.button.disabled = true;
    saving = true;
    updateCount();
    const value = ui.input.value;
    let success = false;
    ui.saveLabel.textContent = "저장 중…";
    setStatus("메모를 저장하고 있어요.");
    try {
      await client.invoke("memo.save", value);
      success = true;
    } catch {
      setStatus("저장하지 못했어요. 작성한 내용은 그대로예요.", "error");
    } finally {
      saving = false;
      ui.button.disabled = !connected;
      ui.saveLabel.textContent = "메모 저장";
      if (success && ui.input.value !== value) {
        setStatus("아직 저장하지 않은 변경사항이 있어요.", "dirty");
      }
    }
  });
}
const ready = start();
void ready.catch(() => {
  setStatus("메모를 연결하지 못했어요. 앱을 다시 열어주세요.", "error");
});
