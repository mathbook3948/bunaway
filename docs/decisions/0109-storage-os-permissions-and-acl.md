---
status: accepted
---

# storage는 OS 권한과 ACL 조회를 제공하지 않는다

결정일: 2026-10-27. 검토 기준: main `c2ce1e44`.

## 배경

`storage`가 파일과 디렉터리의 소유자, DACL, 읽기 전용과 숨김 같은 속성을 조회하는 기능을 둘지 검토했다.

현재 구현:

- `storage.stat`은 `kind`, `sizeBytes`, `createdAtMs`, `modifiedAtMs`, `accessedAtMs`만 돌려준다
  (`plugins/storage/src/contract.ts`의 `storageMetadataSchema`). 링크는 따라가며, 대상이 없을 때만 `null`이다.
- 운영체제가 접근을 거부하면 조회와 쓰기가 `PERMISSION_DENIED`로 실패하고 `null`로 숨기지 않는다(`stat`의 계약이며
  조회 경로는 `EACCES`, `EPERM`, 이동과 교체 경로는 `ERROR_ACCESS_DENIED` 등을 이 코드로 옮긴다). Windows에서 읽기 전용 파일의 atomic 덮어쓰기도 같은 코드로 실패한다
  ([storage.stat](../site/src/content/docs/reference/host/storage-stat.mdx),
  [storage.writeText](../site/src/content/docs/reference/host/storage-write-text.mdx)).
- 경로 제한은 앱 책임이다([ADR 0024](./0024-plugin-path-responsibility.md)).

선례:

- Electron 앱은 Node `fs.stat`의 `mode`를 쓴다. Windows에서 `mode`의 권한 비트는 읽기 전용 여부만 반영하고,
  `uid`와 `gid`는 소유자를 가리키지 않으며, ACL을 읽는 API는 없다. POSIX에서는 `uid`, `gid`와 전체 권한 비트가 있다.
  Node는 `fs.access`, `fs.chmod`, `fs.chown`도 제공한다.

## 결정

1. Windows 파일과 디렉터리의 소유자, DACL, SACL 조회 API를 제공하지 않는다. macOS의 POSIX 모드, uid, gid 조회도
   이번에 추가하지 않는다. `storage.stat`의 스키마와 권한 이름은 바꾸지 않는다.
2. 대상에 접근할 수 있는지는 실제 읽기와 쓰기 호출의 `PERMISSION_DENIED`로 판단한다. `exists`나 `stat`이 성공해도
   읽기와 쓰기가 가능하다는 뜻은 아니다. 접근 가능 여부를 미리 묻는 별도 API(`access`)도 두지 않는다(Node의 `fs.access`와
   다른 점이다). 호출 시점과 실제 사용 시점 사이에 상태가 바뀔 수 있어 사전 확인은 보장이 되지 못하고,
   실제 호출의 오류가 같은 정보를 정확한 시점에 준다.
3. 읽기 전용, 숨김, 시스템 같은 파일 속성은 이 결정에서 추가하지 않는다. 필요가 확인되면 `stat` 결과에 불리언 필드로 따로 더한다.
   Windows의 속성 비트를 그대로 노출하지 않고, macOS에서도 같은 뜻을 가질 필드만 고른다.
4. 권한 변경(chmod, ACL 수정, 소유권 이전)도 제공하지 않는다(Node의 `fs.chmod`, `fs.chown`과 다른 점이다). 앱이 필요하면 자체 백엔드에서 Bun이나 운영체제 도구로 처리한다.

## 이유

- Electron(Node)은 Windows ACL 조회를 제공하지 않는다. `access`와 권한 변경은 Node와 다르지만, 코어는 작게
  두고 쓰는 곳이 없는 기능은 보류한다는 방침을 따른다.
- ACL은 SID, 상속, 거부 항목, 계정 이름 해석을 포함해 공개 계약이 크고, 도메인과 로컬 계정에 따라 결과가 달라 macOS의 POSIX
  모드와 같은 모양으로 맞출 수 없다.
- ACL 목록을 UI에 노출하면 계정 이름과 그룹 구성이 WebView 코드에 전달된다. 접근 가능 여부만 필요한 앱은 오류 코드로 충분하다.
- atomic 덮어쓰기에서 Windows는 읽기 전용, 다른 프로세스의 열림(공유 위반), ACL 거부를 모두 `PERMISSION_DENIED`로
  돌려주므로 앱이 원인을 구분하지 못하고 쓰기를 시도한 뒤에야 실패를 안다. 이 구분이 필요한 화면은 아래 재검토 조건으로 다룬다.

## 다시 검토할 조건

- 읽기 전용이나 숨김 표시가 필요한 파일 관리 화면 요구가 반복될 때. 이때는 `stat`에 불리언 필드를 더하는 안을 먼저 검토한다.
- Node가 Windows ACL 또는 소유자 조회를 추가할 때.
