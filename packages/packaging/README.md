# @bunaway/packaging

채널별 패키징 계약과 어댑터 러너. `bunaway build`의 채널 중립 산출물
(`dist/<target>`)을 읽어 채널별 배포물로 포장한다.

- 계약·검증 규칙: [ADR 0005](../../docs/decisions/0005-packaging-contract.md)
- 단일 소스: 프로젝트 루트의 `packaging.json`(버전 1)
- 진입점: `bunaway package <channel> [directory] [--build]`

채널 어댑터는 `src/channels/<platform>/<channel>.ts`에 두고
`registerAdapter`로 등록한다. 어댑터는 build 산출물을 수정하지 않으며,
서명으로 바뀐 실행 파일은 `packagedSha256`로 기록한다.
