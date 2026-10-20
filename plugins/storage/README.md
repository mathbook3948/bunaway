# Storage

공개 작업과 권한은 [저장 가이드](../../docs/site/src/content/docs/guides/storage-and-state.mdx)를
따른다. Windows와 macOS의 공개 작업과 권한 계약은 유지한다.

열다섯 작업의 입력, 출력 스키마와 handler는 `src/operations.ts`에서 한 번 선언하고 두 플랫폼이 공유한다.
경로 규칙, 네이티브 검증과 호스트 통합 의존성은
[macOS 저장 어댑터](../../docs/architecture/macos-storage-adapter.md)에 기록한다.

Windows와 macOS는 `node:fs` 위의 공통 어댑터를 쓴다. `src/platforms/node-storage.ts`가 읽기와 쓰기, 복사, 목록, 생성,
삭제와 용량 계산을 구현한다. 플랫폼 파일은 경로 문법과 덮어쓰지 않는 이동만 맡는다.
`windows-path.ts`는 경로 형식(드라이브 또는 UNC 절대 경로, 파일 이름 규칙, 장치 접두사 거부)을 검사하고
`windows.ts`는 `MoveFileExW`를 덮어쓰기 플래그 없이 호출한다. `macos-path.ts`는 POSIX 절대 경로 문법을 검사하고
`macos.ts`는 `renamex_np`를 `RENAME_EXCL`로 호출한다. 링크는 일반 경로처럼 따라가고
어떤 위치를 허용할지는 앱 명령이 정한다([ADR 0024](../../docs/decisions/0024-plugin-path-responsibility.md)).
`windows-path.ts`의 `toFileSystemPath`는 검사를 통과한 경로가 248자 이상일 때만 `\\?\`(UNC는 `\\?\UNC\`) 접두사를 붙여
`LongPathsEnabled` 설정 없이도 260자를 넘는 경로를 열게 한다. Node와 Rust 표준 라이브러리의 방식과 같고, 앱 입력의
접두사 거부와 공개 계약은 그대로이며 반환 값과 오류에는 접두사가 나타나지 않는다. `windows-storage-long-path.ts`가
CI windows-native에서 400자를 넘는 경로의 쓰기, 읽기, 목록, 복사, 이동, 삭제를 확인한다.
removeRecursive와 directorySize는 트리 안의 링크를 따라가지 않는다.
`defineNativeOperation<Instance>()`으로 handler 입력, 인스턴스와 반환 타입을
스키마 및 인스턴스 타입에서 추론한다.
`src/index.ts`는 각 작업 맵을 해당 platforms의 operations에 연결하고 인스턴스 수명을 지정한다.
최상위 공통 작업 맵은 없다. 공개 Storage 인터페이스는 작성자가 `src/contract.ts`에 정의한다.
재사용하는 값 스키마도 이 파일에 두며 SDK가 공통 스키마 선언을 요구하지 않는다.
지원 정보는 각 플랫폼 operations의 키에서 생성하며 이름별 execute 분기를 작성하지 않는다.
