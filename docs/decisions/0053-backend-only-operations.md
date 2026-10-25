---
status: accepted
---

# 파일 경로를 읽는 이미지 작업은 백엔드 전용 작업으로 제공한다

결정일: 2026-10-25. 검토 기준: main `b2061c78`.

## 배경

이미지 리소스를 파일 경로에서 만드는 기능과 파일 기반 thumbnail을 제공할지, 제공한다면 경로 접근을 어떻게 다룰지 정해야 했다.

- Electron의 `nativeImage.createFromPath`는 main 프로세스에서 임의 경로를 읽는 API이고, 렌더러는 앱이 만든 IPC를 거쳐서만
  쓸 수 있다.
- `image.createBytes`는 인코딩된 입력을 600,000바이트와 4,096 픽셀, 524,288 바이트의 이미지 상한으로 제한한다. 일반 사진은
  이 상한을 넘으므로 `storage.readFile`로 읽어 `createBytes`에 넘기는 방법으로는 thumbnail을 만들 수 없다. 큰 파일을 읽고
  디코드하면서 축소하는 경로가 필요하다.
- 플러그인 작업은 정책의 `host.permissions`와 `commands`를 통해 화면이 직접 호출할 수 있다. [ADR 0024](./0024-plugin-path-responsibility.md)는
  경로 제한을 앱 명령이 맡고, 화면에는 경로를 제한하는 앱 명령만 허용하도록 정했다. 그러나 정책에는 이 규칙을 강제하는 장치가 없어,
  경로를 받는 작업을 화면에 직접 허용하면 그 화면이 임의 파일을 읽는 입력을 만들 수 있다.
- 이미지 파일은 네이티브 디코더(WIC)가 처리하는 신뢰할 수 없는 입력이다. 크기와 종류를 읽기 전에 제한해야 한다.

## 결정

1. `image.createFromPath`를 백엔드 전용 작업으로 제공한다. Windows에서 로컬 드라이브 경로의 PNG, JPEG, BMP 파일을 읽어
   `maxDimension`(기본 4,096)과 리소스 픽셀 상한 안으로 축소한 새 리소스를 만든다. 파일 기반 thumbnail은 같은 작업의 작은
   `maxDimension`으로 만든다.
2. 플러그인 작업은 `backendOnly: true`로 백엔드 전용임을 선언할 수 있다. 정책 검증은 `backendOnly` 작업을 뷰의
   `host.permissions`나 `commands`(`plugin.<작업>`)에 허용한 정책을 거부한다. 백엔드의 `backend.permissions`에는 허용할 수 있다.
   이 규칙은 `backendOnly`를 선언한 작업에만 적용하며 기존 작업의 권한 모델은 바꾸지 않는다.
3. 경로 문법은 드라이브 절대 경로만 받고(UNC, 장치 접두사, `.`와 `..`, 예약된 장치 이름, 대체 데이터 스트림 거부), 열린 파일의
   종류와 크기를 읽기 전에 확인한다. 허용 폴더와 링크 처리는 ADR 0024에 따라 앱 책임이다.
4. 크기 제한은 다음과 같다. 파일은 16 MiB, 가로와 세로는 16,384, 픽셀은 64,000,000개까지이며, 헤더 크기를 픽셀 디코드 전에
   검사한다. 결과는 기존 이미지 상한(4,096, 524,288 바이트)을 지킨다.
5. 셸의 파일 thumbnail 캐시(`IShellItemImageFactory`)는 이번에 쓰지 않는다. 파일 형식별 미리 보기가 필요하면 후속으로 다룬다.
6. macOS는 이번 변경에서 지원하지 않는다. 입력 스키마가 Windows 드라이브 경로만 받으므로 macOS의 경로는 `INVALID_ARGUMENT`다.

## 근거

- 백엔드는 신뢰된 앱 코드이므로 Electron main 프로세스의 `createFromPath`와 같은 위치에서 경로를 읽는다. 화면이 같은 기능을
  쓰려면 앱 명령이 경로를 정해 호출하므로, 경로 제한 책임이 ADR 0024와 어긋나지 않는다.
- 정책에 허용 폴더(scope) 칸을 두지 않는 기존 방침을 유지한다. 대신 "화면에 허용하지 못한다"는 단순한 검사 하나로, 임의 파일
  읽기가 화면에 직접 열리는 일을 막는다.
- 다른 플러그인의 파일 경로 작업(storage, opener 등)은 이미 화면에 허용된 앱이 있을 수 있어 이번에 바꾸지 않는다.

## 대안

- 제공하지 않는다. 앱은 큰 사진을 디코드하고 축소하는 수단이 없다.
- 저장소의 scope와 권한 검사를 이미지 플러그인에 연결한다. 정책에 폴더 값이 생겨 ADR 0013(optional native plugins)과 ADR 0024의 방침과 어긋난다.
- 화면에도 허용하고 앱 책임으로 둔다. 정책 하나로 임의 파일을 네이티브 디코더에 넘기는 입력이 열리므로 택하지 않았다.

## 영향

- `@bunaway/plugin`의 작업 선언과 `@bunaway/protocol`의 `HostOperationContract`에 선택 필드 `backendOnly`가 생긴다.
- 정책 검증에서 위반은 `INVALID_ARGUMENT`이며 앱 시작과 빌드 시 거부된다.
- Windows 동작은 `tests/lifecycle/windows-image-file.test.ts`가 실제 WIC와 파일 시스템으로 검증한다.
