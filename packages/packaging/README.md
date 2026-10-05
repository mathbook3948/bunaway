# @bunaway/packaging

채널별 패키징 계약과 어댑터 러너. `bunaway build`의 채널 중립 산출물
(`dist/<target>`)을 읽어 채널별 배포물로 포장한다.

- 계약·검증 규칙: [ADR 0005](../../docs/decisions/0005-packaging-contract.md)
- 단일 소스: 프로젝트 루트의 `packaging.json`(버전 1)
- 진입점: `bunaway package <channel> [directory] [--build]`

채널 어댑터는 `src/channels/<platform>/<channel>.ts`에 두고
`registerAdapter`로 등록한다. 어댑터는 build 산출물을 수정하지 않으며,
서명으로 바뀐 실행 파일은 `packagedSha256`로 기록한다.

입력 검증은 필수 앱 자산·실행 설정·플랫폼별 라이선스의 manifest 등재 및 파일 해시를
확인한다. 자산 경로는 상대 경로여야 하며, 입력의 실제 경로가 빌드/패키지 루트 밖으로
벗어나는 symlink/junction도 어댑터 실행 전에 거부한다. Bun의 최종 해시는
`packagedSha256`이며, 없으면 네이티브 호스트와 동일하게 `executableSha256`만 사용한다.

`ctx.addArtifact(path, kind, { signed, signingRequired })`의 `signingRequired`는 기본 true다.
서명이 필요한 배포물이 모두 서명되어야 `submittable:true`이며, `required-to-run`은
동일한 조건으로 `usable`도 판정한다. 체크섬 같은 비배포 부가 파일만
`signingRequired:false`로 제외할 수 있다. 서명된 부가 파일 하나로 미서명 설치 패키지를
실행/제출 가능으로 표시하지 않는다.
