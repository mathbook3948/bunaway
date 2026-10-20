# tray

`@bunaway/plugin-tray`는 `desktop.tray`로 설정한 Windows 아이콘 하나를 제어한다.
계약은 [tray API](../../docs/site/src/content/docs/reference/plugins/tray.mdx)를 따른다.
트레이의 Shell, ICO와 팝업 메뉴 구현은 이 선택 패키지가 소유한다. desktop.tray 사용에는 설치와 tray 등록이 필요하다. 호스트는 실행 유지와 종료 순서, 실패한 네이티브 해제의 재시도를 소유한다.

`NativeEnvironment.tray`의 이름 있는 UI 서비스를 사용하며 icon은 ICO bytes로 받는다.
file loading을 추가하지 않는다. 플러그인은 borrowed app icon과 owned custom HICON을 구분하며
새 shell 설정을 적용한 뒤 이전 custom icon을 해제한다. ICO의 파일/프레임 범위와 decoded 크기를
검사하고 RT_ICON bits를 정렬한 버퍼에 복사한 다음 CreateIconFromResourceEx로 생성한다.

입력은 classic Shell_NotifyIcon mouse callback을 사용한다. NativeEventWaiters는 공통 SDK의
기존 구현을 재사용한다. callback 구독과 대기는 플러그인이, icon과 HWND의 구현은 플러그인이, 정리 순서와 재시도는 호스트가 소유한다.

계약과 ICO 형식은 `tests/api/tray.test.ts`로 확인한다. `windows-tray-controls.test.ts`는 실제
shell 아이콘의 tooltip/ICO 변경과 반복 교체, synthetic mouse 메시지, icon 제거 뒤 TaskbarCreated
알림의 재등록 및 자원 정리를 검사한다. `windows-tray-ui.test.ts`는 실제 UI Worker의 packaged SDK,
창 없는 백엔드 대기와 종료 정리를 확인한다. 두 native 회귀는 `mise run host:windows`에 포함한다.
이는 물리 마우스 입력, 실제 Explorer process 재시작이나 화면의 모든 이미지 모양을 확인했다는 뜻이 아니다.

## macOS

macOS 메뉴 막대 아이콘은 호스트 서비스 없이 이 플러그인이 AppKit(`NSStatusItem`)을 직접 호출해 만든다.
`platforms/macos-status-item.ts`가 FFI 바인딩과 메뉴 선택용 Objective-C 대상 클래스를, `platforms/macos.ts`가
아이콘의 존재 여부, 메뉴 id 매핑과 대기자를 소유한다. 모든 AppKit 호출은 메인 스레드에서 하며, 호출마다
autorelease pool을 비우고, 해제는 메뉴 분리와 해제, 아이콘 제거와 해제, 대상 해제, 콜백 닫기 순서로 한 번만 한다. 대상 클래스는 생성마다 하나씩 등록되어 프로세스 종료까지 남는다. `destroy`는 대기 중인 메뉴 선택 대기를 취소한다.
`tests/api/tray-macos.test.ts`는 계약과 어댑터 규칙을 가짜 바인딩으로 확인하고,
`tests/lifecycle/macos-tray-native.test.ts`는 `macos-native`에서 실제 AppKit 상태를 읽어 title, tooltip, 메뉴와
선택 경로를 확인한다. 이미지는 PNG를 `NSImage`로 읽어 `NSStatusBarButton`에 설정하고(`setSize:`로 점 단위 크기,
`setTemplate:`, `setAccessibilityDescription:`), 단추가 이미지를 유지하므로 읽어 온 참조는 설정 직후 해제한다.
`platforms/macos-png.ts`가 PNG 머리글의 크기를 디코드 전에 검사한다. 메뉴 막대에 실제로 그려지는 모양과
색은 확인하지 않고 AppKit이 보고하는 상태(화소 크기, 점 단위 너비, template, 접근성 이름)만 읽는다. pressed 이미지, 숨김과 `desktop.tray` 연결은 후속 작업이다.

메뉴가 없는 아이콘의 왼쪽과 오른쪽 클릭과 double-click은 `NSStatusBarButton`의 target과 action(left와 right mouse up에서 동작)으로 받아 `tray.input`(`position`은 null)으로 보낸다. 같은 target 클래스에 메서드를 하나 더 두고, 해제할 때 단추의 target과 action을 먼저 비운 뒤 target과 콜백을 닫는다. 메뉴가 붙어 있는 동안에는 어댑터가 이벤트를 보내지 않는다(Linux 테스트로 확인). AppKit이 메뉴를 열면서 action을 보내지 않는 동작, 해제 순서와 실제 클릭은 `macos-native`에서도 확인하지 않고 아이콘이 만들어진 직후의 연결 상태만 읽는다.
