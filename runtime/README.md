# Embedded Bun

- `bun-embed/`: 고정 Bun 소스와 VM 생성·실행·종료 바인딩.
- `patches/`: 내장과 플랫폼 포트에 필요한 패치.
- `build-manifests/`: 소스 commit, 패치, OS SDK, 의존성, 라이선스와 빌드 정보.

`mise.toml`의 Bun 1.4.2는 개발·번들·검사에 쓰는 CLI 런타임이다.
내장 Bun의 소스 commit과 패치 집합은 아직 선정하지 않았다.
CLI 설치를 앱 내부 내장이나 Android·iOS 실행의 검증으로 간주하지 않는다.
