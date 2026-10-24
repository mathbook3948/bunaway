---
status: accepted
---

# 창 위치와 크기 변경의 애니메이션 옵션은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `8f4d5bcb`.

## 배경

`setPosition`, `setSize`, `setOuterSize`, `setContentBounds`, `setOuterBounds`, `center`, `moveToAnchor` 같은 geometry 설정에 전환 애니메이션을 고르는 선택 인자를 둘지 정해야 했다.

- Electron의 `setBounds`, `setContentBounds`, `setSize`, `setContentSize`, `setPosition`은 `animate` 인자를 받지만 문서상 macOS에서만 동작한다. Windows와 Linux 구현은 이 인자를 쓰지 않고 경고 없이 즉시 적용한다. 시간이나 곡선 옵션은 없다.
- Tauri 2의 `setSize`, `setPosition`(Rust `set_size`, `set_position` 포함)과 하위 라이브러리 tao의 공개 API에는 애니메이션 인자가 없다.
- Windows에는 창 geometry를 보간하는 시스템 호출이 없다. 일반 상태의 창은 `SetWindowPos`로 즉시 적용한다. geometry 호출이 애니메이션을 고르는 인자를 제공하지 않는다.
  애니메이션이 필요하면 앱이 타이머로 중간 bounds를 반복해 설정해야 한다.

## 결정

geometry 설정에 `animate` 같은 옵션을 추가하지 않는다. 모든 geometry 설정은 호출이 끝나면 새 값이 반영된 상태이며 전환 효과를 뜻하지 않는다.

- Electron도 Windows에서는 `animate`를 무시하므로 Windows 앱이 Electron에서 얻는 동작과 같다. Tauri와도 같다.
- 두 런타임이 모두 지원하는 공통 동작이 아니므로, 한 플랫폼에서만 동작하는 선택 인자를 계약에 넣으면 같은 호출의 결과가 플랫폼마다 달라진다.
- 앱이 효과를 원하면 `setOuterBounds`를 짧은 간격으로 반복 호출할 수 있다. DPI와 제약 보정이 호출마다 적용된다. 이 반복 호출은 프레임 시간을 보장하지 않으므로 매끄러움은 앱 책임이다.
  창 안의 콘텐츠 전환은 WebView의 CSS 애니메이션으로 처리하는 편이 부드럽다.
- 반복 호출 방식이 실제로 널리 필요해지면 앱이 쓰는 도우미를 플러그인으로 따로 제공할 수 있다. 코어 계약은 바꾸지 않는다.

## 영향

공개 API, 이벤트, 설정과 권한은 바뀌지 않는다. 문서에 geometry 설정에 애니메이션 옵션이 없다는 사실만 적는다.
