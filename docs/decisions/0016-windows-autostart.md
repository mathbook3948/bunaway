---
status: accepted
---

# Windows 사용자 로그인 자동 실행은 선택 플러그인의 HKCU Run 등록으로 제공한다

## 결정과 근거

`@bunaway/plugin-autostart`가 사용자별
`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`의 64비트 뷰를 사용한다.
Win32 REG_SZ의 Unicode 명령줄 하나를 저장하며 관리자 권한, 서비스나 별도 도우미
프로세스를 요구하지 않는다. Windows의 시작 앱 관리 대상이면서 직접 배포와 Store
비패키지 앱에서 같은 구현을 사용할 수 있다.

RunOnce는 반복 로그인이 아닌 일회성 설치 용도다. 작업 스케줄러는 이 범위에 필요하지
않은 작업 설정과 수명 관리가 추가되고 시작 앱 비활성화 계약도 달라진다. Startup
폴더의 바로가기는 더 긴 인자와 작업 디렉터리를 저장할 수 있지만 바로가기 파일,
COM 작성과 파일 수명 관리가 추가된다. 이번 범위는 Run의 문서화된 전체 명령줄
260 UTF-16 코드 단위 제한을 명시적으로 적용한다. 긴 개발 경로와 인자를 지원해야
한다면 제한을 우회하지 않고 별도의 등록 방식을 검토한다.

MSIX는 manifest StartupTask로 사용자 동의를 관리해야 하므로 Run 구현을 사용하지
않는다. 앱 패키지 ID가 있는 프로세스는 등록, 조회와 해제 모두 UNSUPPORTED로 거부한다.
기계 범위 등록과 자동 관리자 권한 상승도 제공하지 않는다.

## 신뢰 경계와 수명

호스트가 검증한 appId, 실제 실행 파일 절대 경로와 개발 부팅 인자를 I/O Worker의
`NativeEnvironment.app`에 전달한다. 사용자 입력에는 앱 ID, 경로와 셸 문자열이 없다.
코어와 UI의 기존 정책 승인을 거친 뒤 어댑터가 엄격한 입력 검사를 수행한다.
뷰는 등록 변경과 조회 권한을 별도로 받아야 한다.

등록 이름은 `bunaway.<실행 모드>.<appId>`로 고정한다. 개발과 배포 이름 공간을
분리하고 같은 ID의 재등록은 값 하나를 원자적으로 교체한다. 실행 경로와 인자를
명시적으로 다시 등록할 때만 갱신하며 조회, 초기화와 종료에서는 등록을 변경하지 않는다.
등록이 같은 경우 쓰기를 생략한다. 삭제는 해당 값만 제거하고 다른 앱을 건드리지 않는다.

Windows argv 규칙에 따라 모든 인자를 별도로 인코딩한다. shell을 거치지 않고
RegSetValueExW, RegGetValueW와 RegDeleteValueW를 직접 사용한다. 저장된 명령줄은
CommandLineToArgvW로 파싱하며 argv 메모리와 레지스트리 핸들은 호출별로 해제한다.
DLL은 어댑터 수명에 속한다. 종료 때 자동 실행 등록은 유지한다.

## 등록과 사용자 비활성화는 별개다

Run 값의 존재는 `registered`다. Windows의 실제 실행 승인과 같지 않다.
`StartupApproved\\Run`은 공개된 안정적 계약이 없으므로 읽기 전용 관찰값으로 취급한다.
12바이트 REG_BINARY에서 상태 0과 2는 활성, 1과 3은 비활성으로 해석한다.
Windows Server 2022의 실제 시작 앱 설정에서 On과 Off 전환 시 0과 1을 확인했다.
그 외 형식과 상태는 `unknown`을 반환한다. 다른 상태의 의미를 홀짝으로 추정하지 않는다.
값이 없다고 활성 상태로 추정하지 않으며 이 키에 쓰거나 지우는 제품 API는 제공하지 않는다.
사용자 비활성화를 등록 갱신이나 삭제로 우회하지 않는다.

현재 계약과 업데이트, 이동, 제거 규칙은
[공개 API](../site/src/content/docs/reference/plugins/autostart.mdx)를 따른다.
숨김 시작, 설치 프로그램 opt-in 및 제거 연동은 후속 작업이다.

## Windows 공식 자료

- [Run and RunOnce Registry Keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)
- [Parsing C command-line arguments](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments)
- [CommandLineToArgvW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw)
- [RegGetValueW](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-reggetvaluew)
- [RegSetValueExW](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regsetvalueexw)
