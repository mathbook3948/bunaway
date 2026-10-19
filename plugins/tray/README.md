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
autorelease pool을 비우고, 해제는 아이콘 제거, 메뉴와 대상 해제, 콜백 닫기 순서로 한 번만 한다.
`tests/api/tray-macos.test.ts`는 계약과 어댑터 규칙을 가짜 바인딩으로 확인하고,
`tests/lifecycle/macos-tray-native.test.ts`는 `macos-native`에서 실제 AppKit 상태를 읽어 title, tooltip, 메뉴와
선택 경로를 확인한다. 이미지, 클릭 이벤트, 숨김과 `desktop.tray` 연결은 후속 작업이다.
