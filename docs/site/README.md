# bunaway 개발 가이드 사이트

Astro Starlight로 만든 한국어 MDX 문서 사이트다. 전체 구조와 개발 환경을 익히고 첫 앱을 실행한 뒤
프로젝트 파일과 뷰별 정책을 살펴본다. 기능별 가이드와 API 레퍼런스에서 필요한 설명을 찾아볼 수 있다.
검색(Pagefind)과 페이지 목차, 이전/다음 탐색, 모바일 메뉴, 테마 전환을 제공한다. 요청 흐름은 단계별로 확인할 수 있다.

## 실행

저장소 루트에서 Bun 1.4.2로 의존성을 설치한다. 문서 사이트 도구 실행에는
Node.js 22.12 이상도 필요하다. 이 도구들은 문서 사이트를 개발할 때 사용한다.

```sh
bun install --frozen-lockfile
bun run docs:dev
```

기본 개발 주소는 `http://localhost:4321`이며 포트가 사용 중이면 CLI가 출력한 주소를 따른다.
개발 서버에서 문서를 편집할 수 있다. 검색 인덱스는 프로덕션 빌드에서 생성되므로 검색을 확인할 때는 preview를 사용한다.

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
텍스트만 있는 페이지는 `.md`로 작성할 수 있다. 컴포넌트나 실제 소스 예제를 표시하려면 `.mdx`를 사용한다.

예제는 `@repo/.../app.ts?raw` 같은 별칭 import와 Starlight `Code` 컴포넌트로
실제 CLI 템플릿을 빌드할 때 문자열로 읽어 표시한다.
템플릿을 바꾸면 예제도 갱신된다. 주변 설명이 새 코드와 맞는지도 함께 확인한다.

`src/reference-map.json`은 공개 export, 메서드, CLI, Host operation의 문서 대응표다.
`scripts/check-reference.mjs`가 TypeScript AST에서 실제 공개 항목과 허용 설정 키를 읽어
누락된 항목과 오래된 매핑, 없는 페이지를 검사한다. 새 API는 대응표와 설명을 함께 추가한다.
자동 검사는 API 이름의 존재 여부를 확인하므로 설명의 정확성은 소스와 대조해 검토한다.
`docs:check`와 `docs:build`가 이 검사를 실행한다. 프로덕션 빌드 후에는 `check-links.mjs`가
내부 페이지 링크와 anchor를 검사한다. CI도 같은 검증과 빌드를 실행한다.

문서 구성은 [Next.js](https://nextjs.org/docs)와 [Tauri](https://v2.tauri.app/start/)를 참고한다.
개발 환경과 첫 앱은 순서대로 따라갈 수 있게 작성하고 기능 가이드는 작업을 중심으로 설명한다.
API 문서에는 인자와 반환값, 기본값을 적고 필요한 권한과 오류 처리, 요청 및 구독의 수명을 설명한다.
예약 설정은 현재 지원 여부를 명시하고 플랫폼 검증 결과는 실행 기록으로 연결한다.

용어는 `docs/GLOSSARY.md`, 제품 방향은 `docs/PRD.md`와 관련 ADR을 따른다.
설계 결정, 실행 기록의 원문은 기존 위치에 유지하고 사이트의 자료 지도에서 연결한다.
플랫폼 런타임과 CLI 생성 앱의 지원 범위를 각각 설명한다. 실행 결과에는 검증한 환경을 함께 적는다.
