---
status: accepted
---

# 생성 앱은 bunaway.json에 빌드·앱·배포 설정을 통합한다

2026-10-06 개발자가 앱 설정을 찾기 쉽도록 새 생성 앱은 다음 구조를 사용한다.

```text
src/                         웹 UI
src-bunaway/
  src/{app.ts,index.ts}       앱 백엔드
  bunaway.json               빌드·앱·배포 설정
  policy.json                뷰·백엔드 접근 정책
```

`bunaway.json`의 `version: 2` 아래에 `build`, `app`, 선택적 `bundle`을 둔다.
`build`는 기존 backend/windowsApp/frontend 경로, `app`은 기존 app.json 객체,
`bundle`은 기존 packaging.json에서 version을 제외한 객체다. 설정의 모든 파일 경로는
설정 파일 위치와 무관하게 프로젝트 루트를 기준으로 한다. 앱 버전 기본값은 계속
프로젝트 package.json에서 읽는다. 권한은 별도 policy.json으로 유지한다.

CLI는 각 영역을 검증한 뒤 기존 내부 Project·PackagingConfig로 변환한다.
bundle 생략은 dev/build를 막지 않지만 package에는 필요하다. bundle을 선언했다면
dev/build/validate에서도 형식을 검사한다. 네이티브 산출물의 assets/app.json과
assets/policy.json, manifest 및 패키징 어댑터 계약은 바꾸지 않는다.
이 결정은 ADR 0005-packaging-contract의 설정 파일 위치·작성 형식만 대체한다.

## 기존 앱 변환

1. 기존 bunaway.json의 version을 제외한 소스 경로 필드를 build에 넣는다.
2. app.json의 객체를 app에 넣는다.
3. packaging.json이 있으면 version을 제외한 객체를 bundle에 넣는다.
4. 최상위 version을 2로 지정하고, 별도 app.json·packaging.json을 삭제한다.
5. bunaway.json과 policy.json을 src-bunaway/에 함께 두고 소스 경로를 갱신한다.
6. bun run validate, bun run typecheck와 대상 플랫폼 dev/build/package를 확인한다.

CLI는 기존 v1 분리 설정을 루트 및 src-bunaway/에서 계속 읽는다. 기존 앱을 자동으로
이동하거나 덮어쓰지 않는다. 두 위치의 bunaway.json 동시 존재와 v2 옆의 분리 설정은
모호한 우선순위를 만들지 않도록 오류로 거부한다. 플랫폼별 override나 HMR 설정은
이번 결정에 추가하지 않는다.
