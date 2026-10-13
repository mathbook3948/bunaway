# Storage

공개 작업과 권한은 [저장 가이드](../../docs/site/src/content/docs/guides/storage-and-state.mdx)를
따른다. Windows 구현과 계약은 변경하지 않는다.

`src/platforms/macos.ts`는 read/write text/bytes, append, exists/stat와 copyFile,
readDirectory와 createDirectory를
macOS I/O Worker에서 제공한다. PR #164의 공유 dispatch와 수명주기를 재사용한다.
move와 remove는 검사한 source 객체의 고정을 보장할 수 없어 macOS에서 `UNSUPPORTED`로
실패하며 지원 목록에 포함하지 않는다. Windows 계약과 구현은 유지한다.

경로 규칙, POSIX 경합의 한계, 네이티브 검증과 호스트 통합 의존성은
[macOS 저장 어댑터](../../docs/architecture/macos-storage-adapter.md)에 기록한다.
