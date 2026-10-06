# bunaway 개발 가이드 사이트

Astro Starlight로 만든 한국어 MDX 문서 사이트다. 전체 구조 → 환경 준비 → 첫 앱 → 프로젝트 파일 →
뷰, 정책 → 기능별 가이드 → API별 레퍼런스 순서로 읽는다. 검색(Pagefind), 페이지 목차,
이전/다음 탐색, 모바일 메뉴, 테마 전환과 요청 흐름의 단계별 설명을 제공한다.

## 실행

저장소 루트에서 Bun 1.4.2로 의존성을 설치한다. 문서 사이트 도구 실행에는
Node.js 22.12 이상도 필요하다. 이는 문서 기여자의 요구사항이며 최종 앱 사용자 요구사항과 다르다.

```sh
bun install --frozen-lockfile
bun run docs:dev
```

기본 개발 주소는 `http://localhost:4321`이며 포트가 사용 중이면 CLI가 출력한 주소를 따른다.
개발 서버에서 문서를 편집할 수 있다. 검색 인덱스는 생산 빌드에서 생성되므로 검색 확인에는 preview를 사용한다.

```sh
bun run docs:check
bun run docs:build
bun run docs:preview
```

정적 출력은 `docs/site/dist/`다. 호스팅을 정하면 `astro.config.mjs`의 `site`와 필요한
`base`를 해당 주소에 맞추고 내부 링크도 확인한다. 현재 자동 게시 설정은 없다.

## 작성 위치

```text
src/content/docs/
  index.mdx                    사이트 시작 페이지
  start/                       전체 구조, 첫 앱
  concepts/                    프로젝트 파일, 창, 뷰, 정책
  guides/                      명령, 이벤트, 저장, 개발, 빌드
  reference/                   설정, API, 지원 범위, 오류, 설계 자료
src/components/CallFlow.astro   저장 요청의 단계별 설명
src/styles/custom.css          사이트 스타일
```

페이지는 `title`과 `description` frontmatter를 가진 Markdown/MDX로 작성한다.
사이드바 순서는 `astro.config.mjs`에서 관리한다. 내부 링크는 사이트 루트 경로를 사용한다.
표준 Markdown은 `.md`로, 컴포넌트, 실제 소스 예제가 필요한 페이지는 `.mdx`로 추가할 수 있다.

예제는 `@repo/.../app.ts?raw` 같은 별칭 import와 Starlight `Code` 컴포넌트로
실제 CLI 템플릿을 빌드 시 읽어 표시한다. 백엔드 구현을 웹 UI에 실행 코드로 import하지 않는다.
템플릿 변경 시 예제는 갱신되지만 주변 설명도 직접 확인해야 한다.

`src/reference-map.json`은 공개 export, 메서드, CLI, Host operation의 문서 대응표다.
`scripts/check-reference.mjs`가 TypeScript AST에서 실제 공개 항목과 허용 설정 키를 읽어
누락, 오래된 매핑, 없는 페이지를 검사한다. 새 API는 매핑과 설명을 함께 추가한다.
본문 키워드 검사는 설명의 정확성까지 증명하지 않으므로 동작 변경도 소스와 대조해야 한다.
`docs:check`와 `docs:build`가 이 검사를 실행하며, 생산 빌드 후 `check-links.mjs`가
전체 내부 페이지 링크, anchor를 검사한다. CI도 같은 문서 검증과 빌드를 실행한다.

문서 구성은 [Next.js](https://nextjs.org/docs)와 [Tauri](https://v2.tauri.app/start/)를 참고한다.
개발 환경과 첫 앱은 순서대로, 기능 가이드는 작업 중심으로, API는 인자, 반환값, 기본값,
권한, 실패, 수명을 설명한다. 현재 구현, 예약 설정, 플랫폼 실행 기록을 구분한다.

용어는 `docs/GLOSSARY.md`, 제품 방향은 `docs/PRD.md`와 관련 ADR을 따른다.
설계 결정, 실행 기록의 원문은 기존 위치에 유지하고 사이트의 자료 지도에서 연결한다.
플랫폼 지원과 CLI 생성 앱의 지원 범위를 구분하며, 과거 실행 결과를 새 환경의 성공으로 쓰지 않는다.
