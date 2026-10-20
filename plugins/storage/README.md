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
`windows-path.ts`의 `normalizeForFileSystem`은 검사를 통과한 모든 드라이브 경로에 `\\?\` 접두사를 붙여
`LongPathsEnabled` 설정 없이도 260자 이상의 경로를 열게 한다. 폴더 순회가 짧은 루트에서 긴 하위 경로를 만들기 때문에
길이와 관계없이 항상 붙이며(UNC 경로는 Bun의 디렉터리 목록이 `\\?\UNC\` 형태에서 실패해 그대로 둔다), 드라이브 경로에 대해서는 Node와 같다. 앱 입력의 접두사 거부와 공개 계약은 그대로이며
목록 결과와 공개 오류 메시지에는 접두사가 나타나지 않는다. `windows-storage-long-path.ts`가
CI windows-native에서 400자를 넘는 경로의 쓰기, 읽기, 목록, 복사, 이동, 삭제가 동작하는지 확인하며
러너의 `LongPathsEnabled` 값을 로그에 남긴다. 이 설정이 꺼진 환경과의 비교는 하지 않았다.
removeRecursive와 directorySize는 트리 안의 링크를 따라가지 않는다.
`defineNativeOperation<Instance>()`으로 handler 입력, 인스턴스와 반환 타입을
스키마 및 인스턴스 타입에서 추론한다.
`src/index.ts`는 각 작업 맵을 해당 platforms의 operations에 연결하고 인스턴스 수명을 지정한다.
최상위 공통 작업 맵은 없다. 공개 Storage 인터페이스는 작성자가 `src/contract.ts`에 정의한다.
재사용하는 값 스키마도 이 파일에 두며 SDK가 공통 스키마 선언을 요구하지 않는다.
지원 정보는 각 플랫폼 operations의 키에서 생성하며 이름별 execute 분기를 작성하지 않는다.
