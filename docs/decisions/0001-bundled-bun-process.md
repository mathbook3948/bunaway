---
status: accepted
---

# 번들 Bun을 별도 자식 프로세스로 실행한다

2026-10-10: macOS 제품 실행도 [ADR 0015](./0015-macos-bun-ffi.md)의 Bun 직접 FFI로 대체됐다.
아래 macOS 자식 프로세스 설명은 이전 실험 기록이다.

2026-10-06: [ADR 0010](./0010-windows-first-platform-model.md)에 따라 Windows를
먼저 완성하고 다른 플랫폼을 같은 Bun 기반 개발 모델에 맞춘다. 아래 macOS 자식
프로세스 구조는 현재 구현 기록이며, 향후 목표는 Bun을 앱 진입점으로 전환하는 것이다.

2026-10-06: Windows 제품 경로는 [ADR 0006](./0006-windows-bun-ui-worker.md)으로 대체됐다.
Windows는 번들 Bun이 앱 진입점이며 같은 프로세스의 UI Worker가 Win32, WebView2를 직접
소유한다. 아래 Windows 설명은 기존 B 실험의 기록이다. macOS의 자식 프로세스 구조는 유지한다.

사용자에게 Bun 설치를 요구하지 않으면서 네이티브 호스트가 백엔드의 시작과 종료를 소유해야 한다. 데스크톱의 기본 실행 구조는 앱에 포함한 Bun 실행 파일을 별도 자식 프로세스로 실행하고 IPC로 연결하는 방식으로 정한다. 동일 프로세스 DLL, VM 내장 실험은 중단했으며, 여기서 런타임을 앱에 내장한다는 뜻은 실행 파일을 함께 배포한다는 뜻이다.

IPC와 프로세스 정리 비용을 감수하는 대신, 호스트에 Bun VM을 직접 넣는 빌드, 수명주기 결합을 피한다. 종료 응답 수신과 실제 프로세스 종료는 구분하며 최종 정리는 호스트가 확인한다. Windows 구현은 Bun을 정지 상태로 생성하고 kill-on-close Job에 배정한 뒤 실행한다.

Windows B 실험에서 구현한 선택이다. macOS, Linux의 실행, 배포와 Android, iOS의 런타임 경로까지 검증됐다는 뜻은 아니며, 모바일 실행 방식은 미확정이다. 이전 [C ABI 초안](../architecture/native-abi.md)은 현재 실행 계약이 아닌 과거 설계 기록으로 남긴다.

근거: [실행 방식과 중단한 실험](../architecture/runtime-feasibility.md), [Windows 실행 결과](../architecture/windows-probe-results.md).
