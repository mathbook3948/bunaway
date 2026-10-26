---
status: accepted
---

# WebView tracing, heap snapshot, JavaScript stack와 hang 진단 수집 API는 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `c6b9ecc9`.

## 배경

앱이 Chromium tracing(category 조회, 기록 시작과 중단, buffer usage)과 고급 진단(process hang, heap snapshot,
JavaScript stack 수집)을 API로 제공할지 정해야 했다. network log는 [ADR 0082](./0082-webview-preconnect-connections-and-net-log.md)가
제공하지 않기로 정했으므로 이 결정에서 다시 다루지 않는다. 프로세스 crash 수집(dump 보관과 최근 crash 조회)은 별도 항목이며
이 결정의 범위 밖이다.

아래 Electron, Tauri, WebView2, Bun 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
기준은 Electron v45.0.0(Chromium 156.0.8078.48), Tauri 2.12.5, wry 0.57.1, WebView2 SDK 1.0.4314.35이다. 이 저장소의 호스트가 쓰는 SDK는 1.0.4129.50이며, 아래 WebView2 API 유무는 위 기준 버전의 `WebView2.idl`을 확인한 것이다.

- Electron은 메인 프로세스의 `contentTracing`으로 `getCategories()`, `startRecording(options)`, `stopRecording(resultFilePath)`,
  `getTraceBufferUsage()`를 제공한다. 결과는 앱이 정한 파일 경로에 기록되며 모든 프로세스(브라우저, 렌더러, GPU)의 이벤트를 포함한다.
  heap snapshot은 `process.takeHeapSnapshot(filePath)`로 메인 프로세스의 V8 힙을 파일로 쓴다. JavaScript stack은 WebFrameMain의
  `collectJavaScriptCallStack()`이 응답 없는 렌더러의 호출 스택을 모으고, 응답 없음은 `unresponsive`와 `responsive` 이벤트로 알린다.
- Tauri 2.12.5와 wry 0.57.1의 소스에서 tracing, heap snapshot, JavaScript stack 수집, 응답 없음 이벤트에 해당하는 공개 API를
  찾지 못했다. 가장 가까운 수단은 `Webview::with_webview`가 넘겨 주는 플랫폼 WebView 핸들을 앱이 직접 다루는 것이다.
- WebView2 SDK의 `WebView2.idl`에는 tracing, heap snapshot, JavaScript stack 수집 전용 API가 없다. 같은 일은 두 경로로만 가능하다.
  하나는 `CallDevToolsProtocolMethod`로 DevTools 프로토콜의 `Tracing`과 `HeapProfiler` 도메인을 부르는 것이다. 다른 하나는 환경을 만들 때
  `AdditionalBrowserArguments`로 `--trace-startup` 같은 Chromium 플래그를 넘기는 것으로, 환경(브라우저 프로세스) 생성 때만 적용된다.
  응답 없는 렌더러는 `ProcessFailed`의 `COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_UNRESPONSIVE`로만 알 수 있고, 그 시점의 호출 스택을
  얻는 API는 없다.
- 이 저장소의 호스트는 `CreateCoreWebView2EnvironmentWithOptions`에 환경 옵션을 넘기지 않는다(`native/windows/bun/webview.ts`).
  `CallDevToolsProtocolMethod` 바인딩은 호스트 내부 동작에만 쓰고 앱에는 노출하지 않으며, 이 호출은 `AreDevToolsEnabled`가 꺼져 있어도
  동작한다.
- tracing과 heap snapshot 결과에는 페이지 메모리의 내용, 방문한 URL, 입력 이벤트 같은 민감한 정보가 들어갈 수 있다. 기록 위치와 보관은
  앱 책임이며 경로 제한은 코어가 맡지 않는 방침([ADR 0024](./0024-plugin-path-responsibility.md))과 맞물린다.
- WebView2의 응답 없는 렌더러는 `windows.waitForProcessFailure`가 `renderer-unresponsive`로 보고한다
  ([Windows 호스트 참조](../site/src/content/docs/reference/host/windows.mdx)). 보고에 담기는 복구 방식(`recovery`)은 같은 참조를 따르며
  이 결정이 바꾸지 않는다.
- 개발 중에는 Windows x64의 `bunaway dev`가 UI DevTools를 연결하므로 DevTools의 Performance와 Memory 패널로 tracing과 heap snapshot을
  수집할 수 있고(패널 구성은 Chromium DevTools의 공개 문서에 따른다), 백엔드는 `bunaway dev --inspect`로 연결한 디버거에서 호출 스택과 힙을 확인한다
  ([디버깅 가이드](../site/src/content/docs/guides/debugging.mdx)). Bun 런타임도 `Bun.generateHeapSnapshot()`으로 백엔드의 힙을 직접 얻을 수 있다.

## 결정

1. tracing(category 조회, 기록 시작과 중단, buffer usage), UI heap snapshot, JavaScript stack 수집 API를 추가하지 않는다.
2. process hang 진단 수집 API를 추가하지 않는다. 응답 없는 렌더러는 기존대로 `windows.waitForProcessFailure`의
   `renderer-unresponsive` 보고로 알리고, 호출 스택 같은 추가 수집은 제공하지 않는다.
3. 대체 API는 두지 않는다. 개발 중 수집은 DevTools와 `--inspect`로, 백엔드 힙은 Bun 런타임으로 충당한다.
4. 배포 앱에서 이 기능이 필요하다는 요구가 확인되면 별도 결정에서 다룬다. 이때 환경 옵션 전달 경로 또는 허용할 프로토콜 도메인 목록,
   개발 모드 한정 여부, 결과 파일에 들어갈 민감 정보와 출력 경로의 책임을 먼저 정한다.

## 근거

- Electron은 tracing과 heap snapshot을 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다.
  쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 이 기능을 요구하는 코드는 없다).
- WebView2에는 전용 API가 없어 Electron의 `contentTracing`과 같은 의미를 약속하려면 DevTools 프로토콜이나 환경 플래그에 기대야 한다.
  환경 플래그는 호스트의 WebView 생성 경로를 바꾸고 환경 생성 뒤에는 켜고 끌 수 없어 `startRecording`, `stopRecording` 의미를 지킬 수 없다.
  프로토콜 호출은 `AreDevToolsEnabled`와 무관하게 동작하므로, 앱에 열면 개발 모드에서만 DevTools를 허용하는 `windows.openDevTools`의
  제한이 적용되지 않는 우회 경로가 된다. 어느 쪽이든 모든 앱의 WebView 생성이나 프로토콜 경계를 바꾸는 일이라 쓰는 곳 없이 먼저 열 이유가 없다.
- 결과 파일에 페이지 메모리와 URL, 입력이 담길 수 있어 앱이 보관과 전송을 잘못 다루면 정보가 유출된다. 쓰는 곳이 없는 기능에 이 위험을
  먼저 들일 이유가 없다.
- 개발자가 필요한 수집은 DevTools UI, `--inspect`, Bun 런타임으로 이미 가능하므로 결정을 미뤄도 앱이 막히지 않는다.
- 응답 없는 렌더러의 보고는 이미 제공하며, 호출 스택을 얻는 WebView2 API가 없어 Electron의 `collectJavaScriptCallStack()`에 해당하는 기능은
  추가할 수 없다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 tracing, network log, 고급 진단 항목을 완료로 표시하고 이 결정과 ADR 0082를 참조한다.
- macOS의 같은 항목은 이 결정에서 바꾸지 않는다.
