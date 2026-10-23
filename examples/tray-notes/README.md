# 트레이 메모 예제

창 하나로 실행하는 상주 데스크톱 앱 예제다. 트레이, `keep-alive`, window-state 저장, 닫기 요청을
함께 쓴다. 구조와 실행 명령은 [memo](../memo/README.md)와 같다. Windows를 대상으로 하며
macOS는 트레이를 지원하지 않아 시작이 `UNSUPPORTED`로 실패한다.

```text
tray-notes/
├─ index.html
├─ package.json
├─ src/
│  ├─ main.ts
│  └─ notes.css
└─ src-bunaway/
   ├─ app.ts
   ├─ notes/
   │  ├─ contracts.ts
   │  ├─ module.ts
   │  └─ service.ts
   ├─ bunaway.json
   └─ policy.json
```

## 동작

- 시작하면 창을 보이지 않은 채 트레이에만 나타난다(`app.windows[0].visible: false`). 트레이 아이콘을 누르거나
  Open을 고르면 창이 보인다. Open이 새로 만든 창은 `visible` 값과 관계없이 항상 표시한다.
- `desktop.closeBehavior: "keep-alive"`이므로 창을 닫으면 창과 WebView, 문서 세션은 정리하지만 백엔드와 트레이는
  계속 실행한다. 다음 Open은 새 창과 새 세션을 만들며, 페이지가 저장한 메모와 창 위치를 다시 불러온다.
  앱 종료는 트레이 Quit으로 한다.
- 닫기 요청: 페이지가 `windows.closeRequested`를 구독하고, 닫히기 전에 `notes.closing`으로 메모와 창 위치
  (`windowState.save`)를 저장한 뒤 `windows.respondClose`로 답한다. 메모를 저장하지 못하면 `allow: false`로
  답해 창을 유지하고 오류를 표시한다. 창 위치 저장 실패는 닫기를 막지 않는다.
- 메모는 입력이 멈추고 0.8초 뒤에 저장한다. 트레이 Quit은 닫기 요청을 거치지 않으므로 마지막 0.8초의 입력과
  창 위치는 저장되지 않을 수 있다.
- 창 위치 복원은 문서가 준비된 뒤 `notes.restoreWindow`로 한다. Open이 이미 창을 표시한 뒤이므로 저장한
  위치로 옮겨지는 모습이 잠깐 보일 수 있다.

## 정책

뷰 하나에 필요한 권한만 둔다. 저장소 경로는 앱이 정하고 페이지는 메모 텍스트만 보낸다. window-state는
호출한 뷰의 권한으로 `windows`와 `store`를 부르므로 창 위치 저장과 복원에 필요한 작업을 `policy.json`의
`host.permissions`에 둔다. `store.*`는 모든 저장소 이름에 적용되므로 앱에 번들한 문서만 여는 뷰에서만 이렇게 허용한다.
메모를 읽지 못하면 입력을 막고, 읽기 전에 닫기 요청이 오면 빈 입력으로 저장된 메모를 덮어쓰지 않도록 저장 없이 닫는다.

## 실행

저장소 루트에서 프레임워크 패키지를 만든 뒤 이 폴더에서 `bun run dev`, `bun run build`, `bun run package`를
실행하는 방법은 memo 예제와 같다.
