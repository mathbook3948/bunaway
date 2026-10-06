---
status: accepted
---

# 생성 앱은 bunaway.json에 빌드·앱·배포 설정을 통합한다

2026-10-06: [ADR 0010](./0010-windows-first-platform-model.md)이 앱 진입점 결정을
부분 대체한다. 목표는 `app.ts`의 공통 앱 정의 하나이며 플랫폼별 부팅은 프레임워크가
담당한다. 기존 `app.ts`·`index.ts`와 `backend`·`windowsApp` 분리를 제거하고
아래 단일 앱 정의 구조와 `build.app`을 적용했다. 설정 통합과 정책 분리 결정은 유지한다.

2026-10-06 개발자가 앱 설정을 찾기 쉽도록 새 생성 앱은 다음 구조를 사용한다.

```text
src/                         웹 UI
src-bunaway/
  app.ts                    공통 앱 정의
  bunaway.json               빌드·앱·배포 설정
  policy.json                뷰·백엔드 접근 정책
```

`src-bunaway` 자체가 앱 백엔드 소스 디렉터리이므로 내부에 `src`를 중첩하지 않는다.
`app.ts`는 AppDefinition을 default export하며 플랫폼별 부팅은 프레임워크가 담당한다.
소스 파일의 이름과 위치는 `build.app`에서 지정하므로 다른 경로도 사용할 수 있다.

`bunaway.json`의 `version: 1` 아래에 `build`, `app`, 선택적 `bundle`을 둔다.
`build`는 app/frontend 소스 경로, `app`은 앱 ID·창·시작 페이지,
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

## 앱 진입점 마이그레이션

기존 `build.backend`와 `build.windowsApp`은 제거하고 AppDefinition을 default export하는
모듈을 `build.app`에 지정한다. 부팅용 `index.ts`는 더 이상 필요 없다. 기존 프로세스
진입점을 앱 정의로 자동 해석하지 않으며 이전 설정은 명시적인 마이그레이션 오류로 거부한다.

외부 UI 개발 서버의 `dev` 설정과 HMR 연결은 후속 [ADR 0009](./0009-development-server.md)이 확장한다.
