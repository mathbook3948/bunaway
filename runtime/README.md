# Bundled Bun

- `bun-bundle/`: 앱에 포함할 플랫폼별 Bun 실행 파일과 배포 자산 영역.
- `patches/`: 공식 배포물로 해결할 수 없어 실제로 필요한 경우의 패치.
- `build-manifests/`: 버전, 소스 revision, 배포 URL, 아카이브·실행 파일 해시,
  OS·CPU, 라이선스와 필요한 경우의 빌드 정보.

네이티브 호스트가 패키지의 Bun을 절대 경로로 자식 프로세스로 실행하고 IPC로 통신한다.
사용자의 별도 Bun 설치나 PATH에 의존하지 않는다. DLL과 Bun VM용 C ABI는 요구하지 않는다.

mise의 Bun 1.4.2는 개발·번들·검사용 CLI다. 공식 Windows x64 baseline 1.4.2 실행 파일의
revision·아카이브·실행 파일·라이선스 해시를 [manifest](./build-manifests/windows-x64.json)에
고정했다. 소스 패치는 없다. [Windows B 실험](../docs/architecture/windows-probe-results.md)에서
사용자 Bun이 없는 PATH, 한글·공백 경로와 다른 cwd의 패키지 실행을 검증했다.

이전 DLL 실험은 중단하고 실험용 코드·소스 변경을 제거했다. 무시되는
`bun-embed/vendor/` 소스와 프로젝트 `build/` 도구·캐시는 제품 의존성으로 사용하지 않는다.
[B 단계 계획](../docs/architecture/runtime-feasibility.md)을 따른다.
