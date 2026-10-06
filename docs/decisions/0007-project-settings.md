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

`bunaway.json`의 `version: 1` 아래에 `build`, `app`, 선택적 `bundle`을 둔다.
`build`는 backend/windowsApp/frontend 소스 경로, `app`은 앱 ID·창·시작 페이지,
`bundle`은 채널별 배포 설정이다. 설정의 모든 파일 경로는 설정 파일 위치와 무관하게
프로젝트 루트를 기준으로 한다. 앱 버전 기본값은 프로젝트 package.json에서 읽는다.
권한은 별도 policy.json으로 유지한다.

CLI는 각 영역을 검증한 뒤 기존 내부 Project·PackagingConfig로 변환한다.
bundle 생략은 dev/build를 막지 않지만 package에는 필요하다. bundle을 선언했다면
dev/build/validate에서도 형식을 검사한다. 네이티브 산출물의 assets/app.json과
assets/policy.json, manifest 및 패키징 어댑터 계약은 바꾸지 않는다.
이 결정은 ADR 0005-packaging-contract의 설정 파일 위치·작성 형식만 대체한다.

## 단일 작성 형식

프로젝트 설정은 `src-bunaway/bunaway.json`의 version 1 형식만 읽는다.
루트 설정 탐색과 분리 설정 로딩, 이전 작성 형식으로의 fallback은 제공하지 않는다.
`bundle`에는 별도 version을 두지 않는다. 플랫폼별 override나 HMR 설정은
이번 결정에 추가하지 않는다.
