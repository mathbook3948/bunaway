---
status: accepted
---

# 온디바이스 언어 모델 API(localAIHandler, LanguageModelUtility)는 제공하지 않는다

결정일: 2026-10-26.

## 배경

Electron이 실험 기능으로 제공한다고 알려진 `localAIHandler`와 `LanguageModelUtility`에 대응하는 기능을 Windows에서 제공할지
정해야 했다. 이 기능은 페이지의 온디바이스 언어 모델 접근(Chromium의 Prompt API)을 메인 프로세스의 핸들러와 유틸리티
프로세스로 연결하는 것으로 이해했다.

아래 Electron, Tauri, Chromium, WebView2 서술은 이 저장소의 테스트나 소스 확인으로 검증한 것이 아니다. 버전별 API 이름과 상태를
확인하지 못했으므로 단정하지 않고, 확인하지 못한 항목은 그렇게 표시했다.

- Electron: 앱 코드가 메인 프로세스에서 핸들러를 등록해 페이지의 언어 모델 호출을 처리하게 하는 실험 API가 있다고 알려져 있다.
  정확한 시그니처, 유틸리티 프로세스 모델과의 관계, 버전별 실험 표시는 확인하지 못했다.
- Tauri와 wry: 대응 기능이 있는지 확인하지 못했다. 이 결정은 Tauri에 같은 기능이 없다는 전제에 기대지 않는다.
- WebView2: Prompt API와 Chromium 내장 AI API를 어느 채널과 기본값으로 노출하는지 확인하지 못했다. Chromium에서 이 API가
  플래그나 원본 평가판 같은 제한된 경로로 열리는지, WebView2에서 같은 경로가 열려 있는지도 알 수 없다.
- 브라우저 인자로 이 기능을 켜고 끄는 방식이 WebView2에서 동작하는지 확인하지 못했다. 이 호스트는 브라우저 인자를 넘기지 않고,
  배포 앱에서는 환경 변수 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`가 그대로 유효하다
  ([ADR 0030](./0030-launch-arguments-and-environment.md)). 인자는 환경 생성 때만 적용되고 같은 사용자 데이터 폴더의 브라우저
  프로세스 전체에 걸린다([ADR 0065](./0065-webview-content-settings.md)).

이 저장소에서 확인한 것은 다음과 같다.

- 신뢰된 백엔드는 Bun의 `fetch`로 모델 서버를 직접 호출하고 `Response.body` 스트림을 읽을 수 있다
  ([network 레퍼런스](../site/src/content/docs/reference/plugins/network.mdx)의 "신뢰된 backend의 HTTP stream 대응").
  `network.request`는 정책 중재 호출이고 본문 64 KiB, 타임아웃 30초로 제한되며 공개 stream이 없으므로 언어 모델 응답 전용
  경로로는 맞지 않는다. `network.exchange`는 제한된 WebSocket 교환이다.
- `processes.run`은 Windows에서 drive로 시작하는 절대 로컬 `.exe` 경로만 받고 stdin과 출력이 각각 64 KiB로 제한된다.
  오래 실행하는 모델 프로세스는 Windows 전용인 `processes.spawn`과 `read`, `write` 계열이 맡고 macOS에서는 `UNSUPPORTED`다
  ([process 레퍼런스](../site/src/content/docs/reference/plugins/process.mdx)).
- UI는 `commands`로 백엔드를 부르고 결과는 이벤트로 받는다.

## 결정

1. 온디바이스 언어 모델용 핸들러, 유틸리티 프로세스, 모델 선택과 다운로드 API를 코어와 공개 계약에 추가하지 않는다.
2. WebView2의 Prompt API와 내장 AI API를 켜거나 끄는 설정도 추가하지 않는다. WebView2 런타임 기본값을 따른다. 기본값은 확인하지
   못했고, 결정은 켜짐이든 꺼짐이든 같다. 앱은 페이지에 이 API가 있다고 가정하지 않는다.
3. 대안은 백엔드가 모델을 호출하고 결과를 `commands` 응답이나 이벤트로 UI에 전달하는 것이다. 모델 서버 호출은 백엔드의 `fetch`,
   로컬 모델 실행은 프로세스 플러그인을 쓴다. 이 플러그인들의 권한 이름은 플러그인이 정하고, 앱은 어떤 권한을 부여할지와 모델 경로,
   다운로드 대상을 정한다.
4. 아래 조건 중 하나가 생기면 별도 결정에서 다시 검토한다. 그때 코어 계약이 아니라 선택 플러그인으로만 두는 안을 기본으로 한다.
   - WebView2가 안정 채널에서 Prompt API를 기본 제공한다고 공식 문서로 확인될 때. 이 경우 설정 노출 여부만 후속 항목으로
     분리한다.
   - Electron 문서에서 해당 API의 실험 표시가 사라질 때.
   - 이 저장소의 앱이 페이지에서 직접 호출하는 온디바이스 모델을 요구한다고 확인될 때.

## 근거

- 쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 온디바이스 언어 모델을 요구하는 코드는 없다). 코어는 작게 두고 기능은 필요한
  곳에 맞춘다.
- Electron 방식은 실험 API이고 WebView2 쪽 노출 상태를 확인하지 못했으므로, 같은 이름의 계약을 만들면 약속하는 동작을 보장할 수
  없다.
- 백엔드가 모델을 호출하는 방식은 기존 권한 모델과 신뢰된 백엔드 경로를 그대로 쓴다. 모델 파일 경로와 다운로드 대상은 파일
  시스템과 네트워크 접근이므로 앱이 필요한 범위만 정하는 편이 맞고, 코어가 모델 저장소를 소유하면 모든 앱에 영향을 주는 경계가
  늘어난다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
