# Storage

공개 작업과 권한은 [저장 가이드](../../docs/site/src/content/docs/guides/storage-and-state.mdx)를
따른다. Windows와 macOS의 공개 작업과 권한 계약은 유지한다.

`src/platforms/macos.ts`는 read/write text/bytes, append, exists/stat와 copyFile,
readDirectory와 createDirectory를
macOS I/O Worker에서 제공한다. PR #164의 공유 dispatch와 수명주기를 재사용한다.
move와 remove는 검사한 source 객체의 고정을 보장할 수 없어 macOS에서 `UNSUPPORTED`로
실패하며 macOS handler를 선언하지 않는다.

경로 규칙, POSIX 경합의 한계, 네이티브 검증과 호스트 통합 의존성은
[macOS 저장 어댑터](../../docs/architecture/macos-storage-adapter.md)에 기록한다.

Windows와 macOS가 함께 지원하는 11개 작업은 `src/operations.ts`에서 입력, 출력 스키마와
handler를 한 번 선언한다. `src/platforms/windows-operations.ts`는 이 목록에 move와 remove를 추가한다.
`defineNativeOperation<Instance>()`으로 handler 입력, 인스턴스와 반환 타입을
스키마 및 인스턴스 타입에서 추론한다.
`src/index.ts`는 각 작업 맵을 해당 platforms의 operations에 연결하고 인스턴스 수명을 지정한다.
최상위 공통 작업 맵은 없다. 공개 Storage 인터페이스는 작성자가 `src/contract.ts`에 정의한다.
재사용하는 값 스키마도 이 파일에 두며 SDK가 공통 스키마 선언을 요구하지 않는다.
지원 정보는 각 플랫폼 operations의 키에서 생성하며 이름별 execute 분기를 작성하지 않는다.
