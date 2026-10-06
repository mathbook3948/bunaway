---
status: accepted
---

# 개발자용 artifact는 완전한 프레임워크 소스를 제공하고 생성 앱은 vendor snapshot을 유지한다

2026-10-06 생성 앱 vendor snapshot과 별도 잠금 파일은
[설치 패키지 결정](./0008-installed-framework-packages.md)으로 대체했다. 아래는 이전 결정의 기록이다.

개발자는 bunaway 저장소를 체크아웃하지 않고 create → dev → build를 실행해야 한다.
현재 네이티브 도구는 고정 runtime manifest·스키마·네이티브 소스가 같은 프레임워크
트리에 있다고 가정한다. SDK만 registry에 올리면 생성 앱의 native build 도구가
빠지거나 전역 CLI 버전과 앱 SDK가 엇갈린다.

CLI JS 번들, 여섯 TypeScript 패키지, vanilla 템플릿, 네이티브 소스/빌드 도구,
스키마·런타임 핀·라이선스 원문을 하나의 로컬 npm-compatible tarball로 만든다.
CLI의 runtime dependency는 번들하고 SDK 소스는 생성 앱 안의 workspaces로 연결한다.
큰 native dependency/runtime는 기존 핀과 해시 검증 다운로드 경로를 재사용한다.

생성 앱은 vendor snapshot을 유지한다. 원본 저장소/설치 도구를 삭제하거나 앱을 이동해도
독립 빌드할 수 있고, registry의 여러 SDK 버전을 혼합하지 않는다. 비용은 앱 저장소의
소스 중복, 더 큰 artifact, 전체 교체 방식의 업그레이드다. 독립 SDK registry 패키지와
버전별 native tool 패키지는 향후 성숙한 release pipeline에서 재검토할 수 있지만
현재 독립성과 원자적 릴리스 결합을 약화시키지 않는다.

framework.json은 framework/SDK/host의 정확한 동일 릴리스와 독립적인 Web/IPC 버전을
기록한다. 앱의 bunaway.lock.json은 snapshot의 파일 해시를 고정하며 모든 실행/빌드
검증에서 부분 교체·버전 불일치를 거부한다. wire major 거부/minor 협상 규칙 자체는
바꾸지 않는다. 앱 package 채널의 설정·서명·설치 계약과 프레임워크 artifact 계약은
분리한다. 번들 Bun의 절대 경로/고정 해시 실행과 전역 fallback 금지는 ADR 0001 그대로다.

프레임워크/템플릿 라이선스 선택은 소유자 결정이다. local artifact는 UNLICENSED로
표시하며 공개 publish하지 않는다. upstream 라이선스는 원문과 해시를 보존한다.
설치/업그레이드·개발자/최종 사용자 요구사항은 [배포 문서](../framework-distribution.md)에 따른다.
