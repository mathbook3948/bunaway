# Storage

공개 작업과 권한은 [저장 가이드](../../docs/site/src/content/docs/guides/storage-and-state.mdx)를
따른다. Windows와 macOS의 공개 작업과 권한 계약은 유지한다.

`src/platforms/macos.ts`는 read/write text/bytes, append, exists/stat와 copyFile,
readDirectory와 createDirectory를
macOS I/O Worker에서 제공한다. PR #164의 공유 dispatch와 수명주기를 재사용한다.
move, remove, removeRecursive와 directorySize는 macOS에서 `UNSUPPORTED`로 실패하며 macOS handler를 선언하지 않는다.
macOS 어댑터는 아직 이전 방식이다.

경로 규칙, POSIX 경합의 한계, 네이티브 검증과 호스트 통합 의존성은
[macOS 저장 어댑터](../../docs/architecture/macos-storage-adapter.md)에 기록한다.

Windows와 macOS가 함께 지원하는 11개 작업은 `src/operations.ts`에서 입력, 출력 스키마와
handler를 한 번 선언한다. `src/platforms/windows-operations.ts`는 이 목록에 move, remove,
removeRecursive와 directorySize를 추가한다.

Windows는 `node:fs` 위의 공통 어댑터를 쓴다. `src/platforms/node-storage.ts`가 읽기와 쓰기, 복사, 목록, 생성, 삭제와
용량 계산을 구현하고, `windows-path.ts`가 경로 형식(드라이브 또는 UNC 절대 경로, 파일 이름 규칙, 장치 접두사 거부)을 검사하며,
`windows.ts`가 덮어쓰지 않는 이동(`MoveFileExW`)만 네이티브로 호출한다. 링크는 일반 경로처럼 따라가고
어떤 위치를 허용할지는 앱 명령이 정한다([ADR 0024](../../docs/decisions/0024-plugin-path-responsibility.md)).
removeRecursive와 directorySize는 트리 안의 링크를 따라가지 않으며 macOS에서는 `UNSUPPORTED`이다.
`defineNativeOperation<Instance>()`으로 handler 입력, 인스턴스와 반환 타입을
스키마 및 인스턴스 타입에서 추론한다.
`src/index.ts`는 각 작업 맵을 해당 platforms의 operations에 연결하고 인스턴스 수명을 지정한다.
최상위 공통 작업 맵은 없다. 공개 Storage 인터페이스는 작성자가 `src/contract.ts`에 정의한다.
재사용하는 값 스키마도 이 파일에 두며 SDK가 공통 스키마 선언을 요구하지 않는다.
지원 정보는 각 플랫폼 operations의 키에서 생성하며 이름별 execute 분기를 작성하지 않는다.
