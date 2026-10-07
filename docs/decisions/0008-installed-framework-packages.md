---
status: accepted
---

# 생성 앱은 프레임워크를 패키지 의존성으로 설치한다

2026-10-06 개발 경험을 개선하기 위해 ADR 0005-framework-artifact의 생성 앱 vendor
snapshot과 bunaway.lock.json을 대체한다. 앱마다 프레임워크 소스를 커밋하고 별도
잠금 파일을 유지하는 대신 package.json과 bun.lock으로 같은 버전의 CLI, SDK를 설치한다.

SDK 이름과 명령, 정책, 네이티브 실행 계약은 유지한다. CLI는 네이티브 소스/도구,
스키마, 런타임 핀, 라이선스를 포함하는 설치 패키지다. 앱은 설치된 CLI에서 네이티브
입력을 찾으며 SDK source exports도 설치 패키지에서 해석한다. Windows 호스트의
내부 SDK 참조는 앱과 같은 설치본으로 연결해 클래스 식별성이 달라지지 않게 한다.

배포는 CLI와 여섯 SDK의 npm-compatible tarball을 생성한다. 일반 artifact는 패키지 간
의존성을 정확한 릴리스 버전으로 선언한다. registry publish 전의 --local 묶음은
절대 tarball 경로를 사용하며 create --package-dir으로 앱에도 그 위치를 지정한다.
로컬 묶음은 재설치 시 보관해야 하고 다른 위치로 옮기면 다시 생성한다.
공개 npm publish, 프레임워크 라이선스 결정은 이번 범위가 아니다.

CLI는 패키지 버전, 해석 경로와 CLI inventory를 검사한다. 앱별 소스 snapshot hash는
제거하고 설치 재현성은 bun.lock과 패키지 관리자에 맡긴다. 최종 배포물의 번들 Bun, 자산
해시와 런처 검증, 프로토콜 협상, 기본 거부 권한은 유지한다.
네이티브 다운로드/컴파일 캐시는 CLI 패키지의 생성 디렉터리에 저장하므로 node_modules
재설치 시 없어진다. 원본 앱 소스와 설정은 이동, 업그레이드 과정에서 보존한다.

배포 전에는 현재 구조만 지원하고 설정 형식은 v1을 유지한다. 이전 vendor/workspace
구조와 분리 설정에 대한 호환 처리, 자동 마이그레이션은 구현하지 않는다.
상세 설치 흐름과 로컬 묶음 제약은 [설치 안내](../framework-distribution.md)에 있다.

[ADR 0012](./0012-optional-native-plugins.md)는 선택 네이티브 플러그인을 개별 패키지로
설치하는 후속 모델을 정한다. 공통 SDK의 동일 버전과 설치본 검사는 유지하며,
선택 플러그인을 CLI의 필수 의존성에 포함하지 않는다. 이관은 아직 구현하지 않았다.
