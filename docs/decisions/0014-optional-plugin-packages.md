---
status: accepted
---

# 모든 기능 플러그인을 선택으로 두고 Core에서 분리한다

2026-10-23 후속 결정: [ADR 0026](./0026-single-webview-single-window.md)에 따라 `windows.list`는 제거되고 `windows.isOpen`이 대신한다. 허용된 작업이 앱의 창을 대상으로 한다는 원칙은 그대로다.

결정일: 2026-10-07

[ADR 0013](./0013-optional-native-plugins.md)의 설치, 등록, 권한 및 개별 플랫폼 어댑터 계약은 유지한다. 창 제어가 공통 SDK와 프로토콜에 남아 있고 플러그인 작성 SDK가 Backend SDK를 통해 Core를 의존하는 부분을 제거한다.

저장, 앱 로그, 기능 조회와 창 제어는 각각 선택 패키지다. 공통 SDK나 호스트는 특정 플러그인을 자동 등록하지 않는다. 설치와 앱 등록, permissions 허용이 모두 필요하다. 등록하지 않은 작업은 지원하지 않는다.

@bunaway/plugin-api가 AppDefinition, PluginDefinition, CommandContext와 공통 실행 컨텍스트를 소유한다. Core와 Backend SDK는 이를 사용하며 플러그인 작성 SDK는 Core와 Backend SDK를 의존하지 않는다. browser와 bun의 조건별 호출 모델은 유지한다.

창 제어 패키지는 작업 계약, 권한, 공개 함수와 생성, 재생성 로직을 소유한다. 기본 창과 WebView, 앱 종료와 트레이 수명, 진단은 호스트 자원 관리로 유지한다. 창 제어 플러그인은 호스트가 제공하는 중립 자원 인터페이스를 사용한다.

공통 정책의 windows 필드와 PluginDefinition.requiredHost는 제거한다. 창 제어는 windows.list, windows.show 등 각 operation 이름을 허용한다. 허용된 작업은 앱에 선언된 창을 대상으로 하며 특정 창의 접근 제한은 앱 명령에서 검사한다. 등록 플러그인 없는 정책의 permissions는 빈 배열이다.

Windows 구현을 우선하며 기존 네이티브 플러그인 경계 검증을 보존한다. macOS 네이티브 플러그인 어댑터는 ADR 0013과 같이 후속 작업이다. 기능 조회 문서는 Client SDK가 아닌 선택 플러그인 레퍼런스에 둔다.

## 2026-10-13: 선택 트레이 구현과 함수 맵

기본 창, WebView와 종료 순서는 호스트가 계속 소유한다. 트레이의 Shell_NotifyIcon,
ICO와 팝업 HMENU 구현은 `@bunaway/plugin-tray`가 소유한다. 기본 Open/Quit 메뉴도
이 패키지 안에 있으므로 menu 없이 기본 복원과 종료를 제공한다.
menu은 선택적인 메뉴 정의와 변경, 연결 및 클릭 대기를 소유한다.
트레이 없는 최소 앱과 CLI 배포물에는 이 구현을 넣지 않는다.

이전 결정에서 호스트 자원 관리로 남긴 트레이 구현을 이 경계로 옮긴다.
`desktop.tray`는 복원과 실행 유지 설정으로 유지하지만 앱이 `tray`를 설치하고
등록해야 한다. 빠진 경우 시작을 UNSUPPORTED로 거부한다. 숨김 시작, 마지막 창 닫기,
Open/Quit과 종료 취소의 의미는 바꾸지 않는다. macOS의 트레이와 desktop은 계속 미지원이다.

플러그인 작성자는 defineNativeAdapter에 schema와 setup, handlers, dispose를 작성한다.
handlers의 짧은 키가 지원 작업 목록이며 입력은 schema의 파싱 결과, 반환값은 출력
schema의 입력 타입으로 추론한다. 플랫폼 operations 배열과 switch를 함께 작성하지 않는다.
권한 확인과 파싱, 실행 직전 재검사 및 취소는 SDK와 호스트의 기존 경로를 사용한다.
SDK의 prepare는 선택적인 호출 컨텍스트를 명시적으로 받으며 숨겨진 prepareUI 속성은 제거한다.
이벤트는 defineNativePlugin의 events에 기존 JSON Schema로 함께 등록한다.

이번 변경은 메뉴와 트레이 어댑터에 적용한다. 기존 다른 어댑터의 execute/executeUI 계약,
NativeEnvironment의 좁은 windows, shortcuts, menus, tray 인터페이스는 남는다.
새 일반 서비스 컨테이너나 자동 의존성 주입은 추가하지 않는다. 모니터 열거와 기본 DPI,
창 geometry 및 WebView 기능의 추가 분리는 후속 작업이며 이 변경으로 전체 이관을 선언하지 않는다.

### 앱 작성 전후

이전 app.ts는 desktop 설정만 작성했다.

```ts
export default defineApp({ modules: [], desktop: { tray: { tooltip: "Notes" } } });
```

이제 필요한 패키지를 설치하고 같은 app.ts에서 등록한다.
호스트의 실행 위치, DLL이나 메시지 창 설정은 앱에 노출하지 않는다.

```ts
import tray from "@bunaway/plugin-tray";
export default defineApp({
  modules: [],
  plugins: [tray],
  desktop: { tray: { tooltip: "Notes" } },
});
```

### 플러그인 작성 전후

이전에는 지원 목록과 dispatch를 함께 유지하고 다시 파싱해 타입을 좁혔다.

```ts
platforms: { windows: { thread: "ui", create, operations: ["read"] } }
// create 내부
executeUI(name, input) {
  switch (name) {
    case "demo.read": return read(operations.read.input.parse(input));
    default: throw unsupported();
  }
}
```

이제 setup의 공유 자원과 작업 함수만 선언한다. keys와 schema가 지원과 타입을 정한다.

```ts
const create = defineNativeAdapter(operations, {
  setup: () => ({ reads: 0 }),
  handlers: {
    read(input, context, state) {
      state.reads++;
      return read(input, context.signal);
    },
  },
  dispose() {},
});
// index.ts
platforms: { windows: { thread: "ui", create } }
```

## 2026-10-14: 플랫폼별 작업 선언

위 함수 맵 예시는 당시 이관 단계를 기록한다. 현재 공식 플러그인은
[ADR 0013](./0013-optional-native-plugins.md)의 플랫폼별 operations에 작업마다
input, output과 handler를 선언한다. 공유 상태가 필요하면 플랫폼의 initialize와
dispose를 사용한다. 기존 create 어댑터는 외부 플러그인 호환을 위해 유지한다.
