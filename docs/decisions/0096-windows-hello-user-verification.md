---
status: accepted
---

# Windows Hello 사용자 확인 API는 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `c6b9ecc9`.

## 배경

Windows에서 앱이 Windows Hello(얼굴, 지문, PIN)로 사용자가 지금 장치 소유자인지 확인하는 API(지원 상태 조회, authenticate, 취소)를 제공할지 정해야 했다. `docs/TODO-windows.md`의 모바일 구역에는 같은 이름의 biometric 항목이 따로 있어 둘의 관계도 정한다.

아래 외부 동작은 Electron과 Tauri의 공개 문서를 확인한 것이며 버전을 고정해 재검증하지 않았고 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 생체 인증 API는 `systemPreferences.canPromptTouchID`와 `promptTouchID`이고 macOS의 Touch ID 전용이다. Windows에는 대응 API가 없다.
- Tauri 공식 biometric 플러그인은 Android와 iOS만 지원한다. 데스크톱(Windows, macOS, Linux)은 지원하지 않는다.
- Windows의 Windows Hello 확인은 WinRT의 `UserConsentVerifier`(지원 조회와 확인 요청)로 호출한다. 이 저장소에는 해당 호출도, 결과를 쓰는 기능도 없다.
- 이 저장소의 `safe-storage`는 DPAPI의 current-user 범위로 암복호화하며 대화상자를 금지하고 Windows Hello 사용자 확인을 제공하지 않는다고 문서에 적혀 있다.
- 앱은 `@bunaway/plugin`의 `defineNativeAdapter`로 자체 네이티브 플러그인을 선언하고 구현할 수 있다([네이티브 플러그인 작성](../site/src/content/docs/reference/tooling/native-plugins.mdx), [ADR 0013](./0013-optional-native-plugins.md), [ADR 0014](./0014-optional-plugin-packages.md)).

## 결정

1. 프레임워크와 공식 플러그인은 Windows Hello 사용자 확인 API(지원 상태 조회, authenticate, 취소)를 제공하지 않는다. 코어 계약, 프로토콜, 호스트 변경도 없다.
2. 필요한 앱은 `UserConsentVerifier`를 호출하는 자체 네이티브 플러그인을 작성한다. 확인 대화상자의 소유 창과 UI 스레드 요구를 기존 네이티브 플러그인 계약이 충족하는지는 이 저장소에서 검증하지 않았다. 소유 창을 지정하는 호출 경로가 따로 있는지도 같은 미검증 범위다. 계약이 충족되지 않는 것이 확인되면 결정 5의 공식 플러그인 재검토 조건으로 본다.
3. Windows Hello 확인은 "사용자가 방금 장치 소유자임을 확인했다"는 일회성 신호로 본다. 비밀 보관이 아니므로 결정 5의 후속 결정 전까지 공식 플러그인은 이 확인 결과를 `safe-storage`의 DPAPI 암복호화나 OS credential store 저장에 연결하지 않는다. 앱이 자체 플러그인에서 연결하는 방식은 앱의 책임이다.
4. 이 결정은 Windows 데스크톱에 한정한다. `docs/TODO-windows.md` 모바일 구역의 biometric 항목(Android, iOS)은 모바일 호스트의 권한과 어댑터를 정할 때 따로 다루며 이 결정으로 바꾸지 않는다.
5. 공식 플러그인 요구가 확인되거나 결정 2의 계약 불충족이 확인되면 별도 결정에서 다룬다. 이때 정할 것은 확인 결과를 앱 명령이 어떻게 소비하는지, 확인 요청을 허용하는 권한 이름, 취소, 확인 대화상자의 소유 창 전달, 지원 조회가 반환하는 사유 구분이다.

## 근거

- 두 프레임워크 모두 Windows 데스크톱에 대응 API가 없다. Electron은 macOS 전용이고 Tauri는 모바일 전용이라 같은 방식을 따를 선례가 없다. 선례가 없는 기능을 코어에 넣지 않고 기능은 플러그인 쪽에 두는 방침을 따랐다.
- 이 저장소에 호출자가 없다(저장소 전체에서 `UserConsentVerifier`와 `Windows Hello`를 검색해 `safe-storage` 문서의 비제공 서술 외에 사용처가 없음을 확인했다). 이 결과를 쓰는 기능(예: 확인 후에만 값을 여는 저장소)이 없으므로 계약을 먼저 만들면 소비 방식이 정해지지 않은 채 보안 의미만 넓어진다.
- 확인 결과를 무엇에 연결하는지는 앱마다 다르고, 잘못 연결하면 확인을 우회한 접근이나 인증된 것처럼 보이는 상태가 생긴다. 앱이 자체 플러그인으로 연결하면 이 책임이 앱에 남는다.
- 이 결정은 기존 방침을 확인하는 것이다. 코어 계약을 키우거나 모든 앱의 보안 경계를 바꾸지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
