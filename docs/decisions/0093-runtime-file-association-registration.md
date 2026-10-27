---
status: accepted
---

# Windows 파일 연결 런타임 등록을 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `f5094a4e`.

## 배경

`opener.registerUrlScheme`, `unregisterUrlScheme`, `isUrlSchemeRegistered`처럼 실행 중인 앱이 파일 확장자 하나를
현재 사용자 범위(`HKCU`)의 처리 후보로 등록, 해제, 조회하는 API(`registerFileAssociation` 계열)를 둘지 검토했다.

현재 구현:

- 설치 프로그램은 패키징 채널 설정(`bunaway.json`의 `bundle.channels.<채널>`)의 `associations.files` 선언을 Inno `fileassociations` 작업으로 등록한다(URL scheme은 별도 `urlschemes` 작업). 이 작업은 새 설치에서
  기본으로 선택되지 않으며, 제거와 업데이트에서 앱이 소유한 후보를 정리한다. ProgId(`BW.` 뒤 하이픈 없는 32자리 16진수)와 등록 기록은
  `packages/packaging`이 정하고 `stableGuid`, `AssociationRoot`, 대기 후보 기록을 쓴다.
- 배포 채널 중 `win-direct`와 `win-store-unpackaged`는 Inno 설치 프로그램이다. 포터블 채널은 없다.
  MSIX 채널(`win-store-msix`)은 아직 패키징을 지원하지 않고, 매니페스트 렌더러는 파일 연결과 URL scheme 선언만 렌더링하고, 활성화는 검증하지 않았다.
- 더블클릭은 `앱 실행 파일 "<경로>"`로 새 프로세스를 시작한다. 앱은 초기 실행과 두 번째 실행 모두
  `desktop.onOpen`의 `request.files`(작업 디렉터리 기준 절대 경로)와 `desktop.onOpenUrls`(`file:` URL)로 경로를 받는다.
  두 훅은 `openArguments`가 기본값 `"files-and-urls"`일 때 채워지고, `"raw"`에서는 `argv`만 전달한다.

## 결정

1. 파일 확장자의 런타임 등록, 해제, 조회 API를 제공하지 않는다. 파일 연결은 설치 때 선택하는 후보 등록으로만 둔다.
   설치 뒤에 켜려면 `win-direct`는 설치 프로그램을 다시 실행해 작업을 선택한다. Store가 무인으로 설치하는
   `win-store-unpackaged`는 사용자가 작업을 고를 화면이 없고, 프레임워크가 만드는 제출 자료의 무인 설치 인자는
   `/VERYSILENT`만 다룬다. Inno의 `/TASKS` 인자로 작업을 미리 선택할 수 있지만(패키징 채널 문서의 무인 설치 안내)
   Store 제출 인자에 쓰는 경로는 검증하지 않았고, 모든 사용자에게 연결을 켜므로 사용자가 선택한다는 설치 원칙과도
   맞지 않아 안내하지 않는다.
2. 연결 파일을 여는 경로는 기존 `desktop.onOpen`의 `request.files`와 `desktop.onOpenUrls`를 쓴다. 호스트에 파일 열기
   전용 이벤트를 새로 만들지 않는다. 같은 파일이 두 훅에 모두 전달되므로 앱은 한쪽에서만 처리한다.
3. 받은 경로는 신뢰하지 않는 입력이다. 어디까지 읽고 쓸지는 앱이 정한다
   ([ADR 0024](./0024-plugin-path-responsibility.md)).

## 이유

- 런타임 등록이 필요한 경우는 설치 프로그램 없이 실행하는 개발 실행과, 설치 때 연결을 고르지 않은 사용자가 나중에
  켜는 경우로 좁다. 포터블 채널이 없고 설치 채널에는 `associations` 선언이 이미 있다.
- 런타임 등록은 설치 프로그램이 정리하지 못하는 후보를 남긴다. 설치 때 작업을 선택했거나 나중에 설치 프로그램을
  다시 실행해 선택한 경우에는 설치 프로그램의 ProgId와 별개인 후보가 하나 더 생겨 연결 프로그램 목록에 같은 앱이
  두 번 보인다. 설치 프로그램은 작업을 선택하지 않았다면 자기 ProgId를 만들지 않지만, 어느 경우든 제거 프로그램은
  런타임 후보를 정리하지 못한다. 설치 ProgId를
  함께 쓰려면 opener가 packaging 내부 규칙을 알아야 해서 패키지 경계를 넘는다.
- MSIX 채널이 생기면 파일 연결은 그 채널의 매니페스트 선언으로 다루는 편이 맞다. 패키지 앱에서 런타임 등록이
  동작하는지는 확인하지 않았다.
- URL scheme의 런타임 등록은 이미 제공 중이며 이 결정으로 바꾸지 않는다. 같은 근거를 URL scheme에 적용할지는
  이 결정의 범위 밖이다.
- 새 API는 권한 3개, 확장자 검증과 거부 목록, 소유 표식, 다른 프로그램의 연결을 덮지 않는 규칙을 모두 새로
  유지해야 한다. 코어는 작게 둔다는 방침에서 쓰는 곳이 없는 기능은 보류한다.

## 다시 검토할 조건

- 설치 프로그램 없이 배포하는 포터블 채널을 추가할 때.
- MSIX 채널을 구현할 때.
- `win-store-unpackaged`에서 설치 뒤 연결을 켜는 방법이 필요해질 때.
- 설치 뒤에 연결을 켜 달라는 요구가 반복될 때. 이때는 설치 ProgId를 재사용하는 방식을 packaging 쪽과 함께 설계한다.

## 영향

- 코드와 공개 API는 바뀌지 않는다. `docs/TODO-windows.md`, `opener` 문서와 패키징 채널 문서에 이 결정을 반영한다.
