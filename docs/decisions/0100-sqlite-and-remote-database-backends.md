---
status: accepted
---

# SQLite query, execute, transaction, migration API와 원격 DB backend는 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `c6b9ecc9`.

## 배경

화면이 SQLite에 query, execute, transaction과 migration을 요청하는 공개 API와, PostgreSQL, MySQL 같은 다른 backend 또는 원격 DB
지원을 프레임워크가 제공할지 정해야 했다.

아래 외부 동작은 두 프레임워크의 공개 문서를 확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron은 DB API를 제공하지 않는다. 앱이 메인 프로세스에서 Node 드라이버를 직접 쓴다.
- Tauri는 공식 SQL 플러그인을 제공한다. 이 플러그인은 sqlx 기반으로 SQLite, MySQL, PostgreSQL을 다루고, 화면(JavaScript)에서
  연결, query, execute를 호출한다. Tauri의 백엔드는 Rust라서 Rust 쪽 DB 접근을 대신하는 수단으로도 쓰인다.

이 저장소의 근거는 다음과 같다.

- 백엔드는 Bun이다. [백엔드 Host API](../site/src/content/docs/reference/backend/host-api.mdx)는 신뢰된 백엔드가 `Bun.file`,
  `Bun.write`, `node:path`와 `bun:sqlite`를 직접 쓸 수 있고, 이 경로는 앱 코드가 접근과 수명주기를 관리하며 Host 정책으로
  제한하지 않는다고 안내한다.
- 화면은 앱 명령(`commands`)으로 백엔드를 호출한다. 화면에서 호스트 경계를 넘는 작업은 작업별 권한으로 중재한다.
- 파일 경로 제한은 앱 책임이고 코어는 작게 둔다는 방침이 [ADR 0024](./0024-plugin-path-responsibility.md)에 있다.

Bun 내장 SQL 클라이언트나 npm 드라이버가 지원하는 DB 종류와 기능 범위는 이 저장소에서 확인하지 않았으므로 이 결정은
그 범위에 대해 아무것도 단정하지 않는다.

## 결정

1. SQLite query, execute, transaction과 migration을 위한 공개 API를 코어와 공식 플러그인 계약에 추가하지 않는다.
2. PostgreSQL, MySQL 같은 다른 backend와 원격 DB 지원을 프레임워크 계약에 넣지 않는다. 원격 DB 접속은 앱이 고른 드라이버와
   `network` 권한 정책의 몫이다.
3. 대신 다음을 안내한다.
   - 백엔드 코드에서 `bun:sqlite`를 직접 쓴다.
   - DB 파일 위치는 `path` 플러그인이 알려주는 앱 데이터 경로 아래에 둔다.
   - 스키마 migration은 앱 코드가 정한 순서와 방법으로 수행한다.
   - 화면이 데이터를 필요로 하면 앱 명령으로 백엔드에 요청하고, 백엔드가 SQL을 실행한다.
4. 앞으로 제공하게 되더라도 코어 계약이 아닌 선택 플러그인으로만 둔다. 이 경우 DB 경로, 쿼리 권한, 동시 접근 정책은 앱 책임으로
   둘지 플러그인이 정할지를 그 결정에서 먼저 정한다.

## 근거

- 대체 수단이 이미 있다. Tauri의 SQL 플러그인은 Rust 백엔드가 DB 접근을 갖지 못하는 환경을 보완하지만, 이 프레임워크의 백엔드는
  Bun이라 `bun:sqlite`를 바로 쓴다. 화면에 같은 API를 한 번 더 노출하는 이득이 작다.
- 보안 경계가 커진다. 화면이 임의의 SQL 문자열을 호스트 경계 너머에서 실행하면, 어떤 DB 파일과 어떤 문장을 허용할지, 화면이
  받는 데이터가 어디까지인지 모든 앱에 대해 새로 정의해야 한다. 앱 명령으로 필요한 질의만 열어 두는 현재 구조는 이 경계를
  넓히지 않는다.
- 원격 DB는 계약에 넣을 수 없다. 접속 대상, 인증 정보, 드라이버와 재시도 정책이 앱마다 다르고 프레임워크가 검증할 수 있는
  표준 동작이 없다. 접속 권한은 `network` 정책으로 다루고 그 밖은 앱 코드에 맡긴다.
- migration 도구는 DB 스키마와 데이터 보존 정책에 묶여 있다. 앱마다 요구가 달라 공통 계약으로 굳히지 않는다.
- 두 프레임워크가 다르다. Electron은 아무것도 제공하지 않고 Tauri는 플러그인으로 제공한다. 이 결정은 Electron과 같은 쪽을 따른다.
  Tauri 플러그인이 필요했던 이유(Rust 백엔드의 DB 접근)가 이 프레임워크에는 없고, 기능은 선택 플러그인에 더 맞으며 코어는 작게 둔다는
  방침과 맞기 때문이다.

## 재검토 조건

- 여러 앱이 공통 migration 도구를 요구하는 이슈가 생길 때. 이 경우 migration 부분만 선택 플러그인 후보로 따로 검토한다.
- 화면에서 SQL을 직접 실행해야 하는 사용처가 확인될 때. 이 경우 허용 DB와 문장 범위를 포함한 권한 모델을 먼저 정한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시하고 이 결정을 참조한다.
