---
status: accepted
---

# localhost 자산 서버를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `bb18c2f8`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

패키지의 웹 자산을 `http://localhost:<port>`로 서빙하는 선택 기능을 둘지 정해야 했다.

- Electron은 내장 자산 서버가 없다. 문서는 로컬 페이지를 `loadFile`(`file://`)로 로드하게 안내하고, 보안 가이드는
  `file://` 대신 `protocol.handle`로 만든 사용자 정의 protocol을 권고한다.
- Tauri 2는 `tauri-plugin-localhost`를 코어에 포함하지 않는 선택 플러그인으로 제공한다. 공식 문서는 상당한 보안 위험이
  있으니 확신이 없으면 기본 사용자 정의 protocol을 쓰라고 안내하고, 플러그인 소스 문서(`Builder`)는 서버에 인증이 없어
  같은 기기의 어떤 로컬 프로세스든 접속해 자산을 읽을 수 있다고 경고한다. 기본 자산 경로는 사용자 정의 protocol이다.
- 이 저장소의 Windows 호스트는 `https://app.bunaway.local`로 자산을 로드한다. 컴파일하지 않은 실행은 WebView2 가상 호스트 이름을
  `web` 폴더에 매핑하고 접근 종류 값 2(`DENY_CORS`)를 쓰며, 컴파일된 앱은 매핑 없이 `WebResourceRequested`에서 임베드한
  파일로 응답한다(`native/windows/bun/webview.ts`). macOS와 iOS는 `bunaway://` scheme handler로 같은 자산을 읽는다.
  어느 자산 경로도 네트워크 포트를 열지 않는다. 자산 로딩과 달리 iOS의 백엔드 연결은 loopback WebSocket을 쓰며 이
  결정의 대상이 아니다.
- 개발 모드의 `dev.url`은 localhost 또는 127.0.0.1만 허용하며 개발 산출물에만 적용한다([ADR 0009](./0009-development-server.md)).
  이 결정은 개발 서버를 바꾸지 않는다.

## 결정

1. 프레임워크는 패키지 자산을 loopback HTTP 서버로 서빙하는 기능과 설정을 추가하지 않는다.
2. 프로덕션 WebView의 자산 출처는 지금의 `https://app.bunaway.local`(Windows)과 `bunaway://`(macOS, iOS)로 유지한다.
3. 이 결정은 신뢰된 백엔드가 `Bun.serve`로 자기 서버를 여는 것을 막지 않는다. 다만 그 서버의 출처로 WebView를 이동하는 것은
   앱의 허용 origin 정책이 따로 허용해야 하며, 프레임워크가 서버의 접근 통제를 대신하지 않는다.
4. 가상 호스트와 사용자 정의 scheme으로 만들 수 없는 용도(예: 해당 scheme을 받지 않는 서드파티 컴포넌트)가 확인되면
   별도 결정에서 다룬다.

## 근거

- 두 프레임워크가 다르다. Electron은 제공하지 않고 Tauri는 선택 플러그인으로 제공한다. 이 저장소는 이미 포트를 열지 않는
  자산 경로를 갖고 있고 쓰는 곳이 없으므로 코어를 늘리지 않는다.
- 인증 없는 loopback 서버는 같은 기기의 다른 프로세스(브라우저 포함)가 접속해 자산을 읽을 수 있고, 포트가 실행마다 달라지면
  WebView의 origin과 그에 묶인 저장소, 권한이 안정적이지 않다. 고정 포트는 충돌로 시작이 실패한다.
- 현재 자산 경로는 네트워크 수신 지점이 없어 같은 기기의 다른 프로세스가 직접 접속할 수 없다. 이 성질을 유지한다.

## 결과

- 코드, 이벤트, 권한, 스키마 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
