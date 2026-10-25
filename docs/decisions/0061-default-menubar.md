---
status: accepted
---

# 앱 전체 기본 메뉴바를 자동으로 연결하지 않는다

결정일: 2026-10-25. 검토 기준: main `bb18c2f8`.

## 배경

아래 Electron(v45.0.0)과 Tauri(2.12.5) 서술은 해당 프로젝트의 공식 문서와 해당 태그의 소스 확인에 따른 것이며
이 저장소의 테스트로 검증한 것은 아니다.

앱이 메뉴를 연결하지 않아도 창에 기본 메뉴바를 자동으로 붙일지 정해야 했다.

- Electron은 앱이 `Menu.setApplicationMenu`를 `ready` 전에 호출하지 않으면 기본 애플리케이션 메뉴를 만들고, Windows와
  Linux에서는 이 메뉴가 각 창의 메뉴바가 된다. 기본 메뉴는 File, Edit, View, Window이며 View에 reload, force reload,
  개발자 도구(Ctrl+Shift+I)가 들어 있다. `Menu.setApplicationMenu(null)`은 기본 메뉴를 만들지 않고 Windows와 Linux 창의
  메뉴바도 없앤다.
- Tauri 2는 macOS 빌드에서만 `enable_macos_default_menu`(기본 true)일 때 기본 앱 메뉴를 설정한다. Windows와 Linux에서는
  앱이 `Builder::menu`나 `AppHandle::set_menu`로 메뉴를 지정하지 않으면 창에 메뉴바가 없다(tao의 Windows 창 `menu` 기본값은 None).
- 이 저장소는 창 메뉴바를 `menu.setWindowMenu`로 연결한다. 창이 하나이므로([ADR 0026](./0026-single-webview-single-window.md))
  자동 연결 대상도 그 창 하나다.
  role 항목은 편집 6개(undo, redo, cut, copy, paste, selectAll)와 창 3개(close, minimize, quit)이며,
  보기와 도움말 계열 role(reload, 개발자 도구, about, zoom 등)은 없다.
- 메뉴바는 창의 콘텐츠 영역을 줄이므로 자동 연결은 모든 앱의 창 크기와 레이아웃에 영향을 준다.

## 결정

1. 앱이 연결하지 않은 창에는 메뉴바를 붙이지 않는다. 기본 메뉴 자동 연결과 이를 끄는 옵션을 추가하지 않는다.
2. 앱이 표준 메뉴를 원하면 role 항목으로 직접 만들어 `menu.setWindowMenu`로 연결한다.
3. 메뉴 항목 템플릿을 미리 채워 주는 헬퍼도 두지 않는다. 앱이 같은 항목 배열을 직접 쓰면 되고 쓰는 곳이 없다.
   사용처가 확인되면 별도 결정에서 다룬다.
4. 이 결정은 Windows 호스트 기준이다. macOS 호스트는 이 결정에서 다루지 않는다.

## 근거

- 두 프레임워크가 Windows에서 다르다. Electron은 자동 연결하고 Tauri는 하지 않는다. 자동 연결은 코어 계약을 늘리고
  모든 앱의 콘텐츠 영역을 바꾸므로 코어를 작게 두고 앱이 명시적으로 연결하는 쪽을 따른다. 자동 연결이 없으면 끄는 옵션도 필요 없다.
- 앱은 편집과 창 role 항목으로 편집과 창 메뉴를 직접 구성할 수 있다. 보기와 도움말 항목(reload, 개발자 도구 등)은
  role이 없어 자동 연결하더라도 같은 결과가 되지 않으며, 필요하면 일반 항목과 앱 명령으로 만든다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
