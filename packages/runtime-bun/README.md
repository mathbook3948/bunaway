# Bun 런타임 어댑터

앱 백엔드 진입점에서 `await runBunApp(app)`를 호출한다. 현재 네이티브 연결은
Windows용이며 코어의 플랫폼 서비스도 `windows`다.

호스트가 보낸 boot의 정책·백엔드 컨텍스트·런타임 세대로 `createCore`를 만들고
플러그인 초기화와 hello 협상 뒤 ready를 보낸다. 초기화 중에도 Host API 요청을
발행하고 stdin에서 응답을 처리한다. stdout은 크기·큐 상한을 가진 NDJSON 전용이므로
앱 로그에 `console.log`를 사용하지 않고 Host API `log.write` 또는 stderr를 사용한다.

- `session-open`은 호스트 컨텍스트와 뷰 정책으로 코어 세션을 만든다.
- `web`은 해당 세션에 전달하고 코어 응답·이벤트를 같은 컨텍스트로 중계한다.
- Host API는 요청 ID와 컨텍스트를 모두 대조한다. 취소는 `host-cancel`을 보내며
  대기 항목·abort 리스너를 해제한다. 취소·폐기 뒤 응답은 버린다.
- `revoke`는 세션을 먼저 라우팅에서 제거하고 요청·구독·Host API를 정리한다.
- `shutdown`은 새 작업과 Web 출력을 막고 코어·플러그인을 종료한 뒤 stopping을
  보내고 stdin을 닫는다. 실제 프로세스 종료·Job 정리는 네이티브 호스트가 확인한다.

부팅 전·플러그인 초기화 중 종료도 처리한다. 잘못된 방향·세대·프레임·예상 밖 EOF는
실패로 종료한다. [메모 샘플](../../examples/memo/README.md)과
[Windows 실행 증거](../../docs/architecture/windows-host-results.md)를 참고한다.
