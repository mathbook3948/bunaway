---
status: accepted
---

# 패키징은 채널별 어댑터가 build 산출물을 소비하고, 서명 후 해시는 별도 필드로 둔다

개발자가 자기 앱을 Windows 직접 배포·Microsoft Store·macOS 직접 배포·Mac App Store로
배포하려면 채널별 패키징이 필요하다. `bunaway build`의 채널 중립 산출물
(`dist/<target>/` + `manifest.json`)을 재사용하면서 채널별 요구사항을 분리하는 계약을
`@bunaway/packaging` 패키지에 둔다.

## 단일 소스와 검증

- 프로젝트 루트의 `packaging.json`(version 1)이 앱 이름·식별자·버전·게시자·아이콘·
  대상 OS/CPU·채널별 설정·서명 참조의 단일 소스다. 앱 ID·버전·제목의 기본값은
  `app.json`/`package.json`에서 가져오며 명시 값이 우선한다.
- `packaging.json`은 없어도 된다. 없으면 `build`·`dev`·`validate`는 그대로 동작하고
  `package`만 사용할 수 없다 — 기존 프로젝트의 마이그레이션은 필요 없다.
- 스키마는 기존 설정 파일들과 같은 규칙을 따른다: 알 수 없는 필드·경로 탈출·형식
  위반을 거부하고, 사용할 채널은 `channels.<id>`에 명시해야 한다(`{}`는 기본값).
- 채널이 스토어의 제약을 강제할 수 있는 범위(예: `win-store-unpackaged`의
  WebView2 `check` 전용 — 오프라인 standalone 요구사항)는 검증 단계에서 거부한다.

## build와 package의 책임 분리

- `bunaway build`는 채널 중립이다. 어댑터는 build 산출물 디렉터리를 읽기 전용으로
  소비하고 스테이징 디렉터리에만 쓴다.
- 어댑터 입력: 산출물 디렉터리·`manifest.json`·`policy.json`·`app.json`·라이선스
  맵·해석된 패키징 메타데이터. runner의 `verify` 단계가 manifest의 자산·Bun 해시로
  입력을 재검증하고 누락/변조는 `PKG_INPUT_MISSING`/`PKG_INPUT_TAMPERED`로 거부한다.
- 어댑터는 `resolve → verify → stage → sign → assemble → verify-artifact → report`
  순서의 stage 목록을 정의하고, runner가 단계별 실행·타이밍·실패 포착을 담당한다.
- 진단은 `{stage, code: PKG_*, severity, message, path?}` 형식으로 통일하고 결과는
  `dist/<target>/packaged/<channel>/`과 `packaging-report.<channel>.json`에 남긴다.
  실패한 실행은 직전 정상 산출물을 덮지 않는다(스테이징→원자적 rename).
- 어댑터는 registry에 자기 채널을 등록한다. 새 채널은 `src/channels/<platform>/`
  아래 파일만 추가하며 공통 진입점을 수정하지 않는다.

## 서명과 해시 규칙

서명은 어댑터의 선택적 단계로 분리하고 자격증명은 개발자가 제공한다(인증서 파일·
thumbprint·비밀번호 env 이름만 저장소에 참조). 채널은 `signingRequirement`로
`optional`/`required-to-run`/`required-to-submit`을 선언한다. 미서명 결과는
`submittable:false`로만 기록하고, 실행에 서명이 필요한 채널에서는 `usable:false`다.
서명으로 바이너가 바뀌는 채널을 위해 manifest의 해시를 둘로 나눈다:
`sha256`/`sourceSha256`은 upstream 출처(불변 기록), `packagedSha256`은 서명 후 최종
바이트. 호스트의 런타임 무결성 검사는 `packagedSha256`을 우선 읽고 없으면 기존
필드를 사용하므로 서명이 없는 채널의 검사는 그대로다.

## 검토한 대안

- `build` 명령에 채널 플래그를 추가하는 방식은 채널 중립 산출물 재사용을 깨고
  빌드-패키징 책임을 섞어 채택하지 않았다.
- 채널별 manifest를 산출물마다 두는 방식은 단일 소스·검증 규칙이 갈라져 채택하지
  않았다.

근거: [PRD](../PRD.md), [패키지 구현](../../packages/packaging/), [Windows 호스트
](../../native/windows/host/host.cpp).
