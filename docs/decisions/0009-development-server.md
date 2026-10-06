---
status: accepted
---

# UI 개발 서버는 외부 도구가 소유하고 CLI가 실행 수명주기를 관리한다

Vite·Next.js/Turbopack 등의 개발 서버를 네이티브 창과 연결한다. bunaway가 UI
개발 서버나 HMR을 다시 구현하지 않는다. `src-bunaway/bunaway.json` v1에 선택적
`dev.command`(실행 파일과 인자 배열), `dev.url`, `dev.timeoutMs`를 추가한다.
이 결정은 ADR 0007의 HMR 설정 제외 범위와 기존 CLI의 로컬 자산 전용 dev 제한을
확장한다. 앱·권한 작성 형식, Web/IPC wire 계약과 프로덕션 자산 origin은 유지한다.

CLI는 프로젝트 루트에서 명령을 shell 없이 실행하고 지정 URL의 HTTP 2xx 응답을
기다린 뒤 호스트를 시작한다. 명령 출력은 터미널에 그대로 전달한다. 기존 listener를
임의로 채택하지 않고 포트 충돌로 실패한다. redirect는 준비 완료로 간주하지 않는다.
Windows는 별도 Bun worker의 kill-on-close Job, POSIX는 프로세스 그룹으로 개발
명령의 자손을 종료한다. 서버 조기 종료·timeout·Ctrl+C·창 닫기는 전체 개발 실행을
정리한다. 백엔드 빌드 실패는 서버를 유지하면서 다음 소스 변경을 기다린다.

`dev.url`은 localhost 또는 127.0.0.1의 HTTP(S) URL만 허용하며 TLS 검증을 우회하지
않는다. 개발 산출물의 해시 inventory에 `app.json.development.url`을 포함하고,
호스트 실행의 `--dev-url`과 일치해야 한다. 해당 뷰의 기존 명령·이벤트·Host 권한은
유지하고 생성된 개발 정책의 origin만 정확한 개발 origin으로 교체한다. 작성한
policy.json은 수정하지 않는다. 네이티브가 관찰한 출처·최상위 frame·세션·컨텍스트
검사는 계속 적용한다. Windows 가상 호스트는 app.bunaway.local에만 매핑하며,
macOS는 해당 자산 호스트만 bunaway://로 변환한다. 개발 서버 URL은 변환하지 않는다.

외부 서버 모드에서 CLI는 UI를 검증 번들하거나 배포 자산으로 복사하지 않는다.
프런트엔드 출력 디렉터리가 아직 없어도 개발할 수 있다. UI의 변경·HMR·오류 화면은
서버가 담당한다. CLI는 src-bunaway, backend/windowsApp 진입점 디렉터리와 루트
package.json·bun.lock·tsconfig.json 변경을 감시한다. 백엔드 재시작은 세션을
무효화하며 미완료 요청을 재전송하지 않는다. dev 설정 변경은 서버도 교체한다.

`dev` 생략은 기존 vanilla 전체 호스트 재시작 흐름을 유지한다. 일반 build/package는
개발 URL과 marker를 포함하지 않으며 기존 로컬 자산을 사용한다. 외부 프런트엔드의
프로덕션 빌드 명령 자동 실행, Next.js SSR의 앱 패키징, 새 UI 템플릿은 별도 범위다.
구현과 Linux 계약 테스트는 실제 Windows/macOS 네이티브 검증 완료를 의미하지 않는다.
