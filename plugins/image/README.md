# @bunaway/plugin-image

Windows와 macOS arm64의 선택 이미지 플러그인이다. `defineNativePlugin`과 Zod 계약으로 RGBA,
PNG, JPEG와 BMP bytes, data URL에서 앱 소유 이미지 리소스를 만들고 조회, 인코딩과
해제를 제공한다. 설치와 등록, 각 operation 권한은 별도로 필요하다.

```ts
import { image, imagePlugin } from "@bunaway/plugin-image";

// 앱 정의에 plugins: [imagePlugin]을 등록한다.
const resource = await image.createRGBA({ width: 1, height: 1, rgba: "/wAAgA==" });
try {
  const png = await image.exportDataURL({ id: resource.id, format: "image/png" });
} finally {
  await image.dispose({ id: resource.id });
}
```

공개 입력, 반환값, 권한과 오류는 [API 레퍼런스](../../docs/site/src/content/docs/reference/plugins/image.mdx)에 둔다.
파일 경로 읽기와 저장소 scope 추가, scale representation 그룹과 파일 아이콘은
제공하지 않는다. 파일 bytes의 확보와 저장은 앱이 기존 저장소 계약에서 수행한다.

`image.crop`은 양수 크기의 in-bounds rectangle을 복사하고 `image.resize`는
nearest 또는 linear filtering으로 새 리소스를 만든다. Nearest는 출력 픽셀 중심에
대응하는 소스의 RGBA 네 바이트를 직접 복사해 투명 픽셀의 RGB도 보존한다. 소스는 변경하지 않으며 새 ID도
기존 quota, 생성 취소와 명시적 해제 규칙을 따른다. Linear는 BGRA를 PBGRA로 변환한
뒤 보간하고 다시 straight RGBA로 복사해 투명 edge의 색 번짐을 방지한다. 8-bit 변환의
반올림과 완전히 투명한 픽셀의 RGB 정규화는 API 레퍼런스에서 설명한다.

## 소유권과 Windows 구현

리소스 ID는 앱의 한 어댑터 수명에 속하며 창 탐색이나 정상 호출 완료로 폐기하지 않는다.
각 호출은 해당 operation 권한과 ID를 모두 요구한다. 권한을 받은 출처끼리 ID를 전달할
수 있으며 특정 리소스의 접근 제한은 앱 명령에서 검사한다. 재시작 뒤 이전 ID는 유효하지 않다.
최대 64개 리소스와 8 MiB의 픽셀을 보유한다. 빈 이미지도 슬롯을 사용한다.

호스트가 생성 작업을 완료하기 전에 요청의 signal이 취소되면 새 리소스를 버리고 슬롯과
메모리 예산을 복원한다. 완료한 생성은 뒤늦은 화면 취소로 되돌리지 않는다. 성공적으로
받은 ID는 앱이 `image.dispose`로 해제한다. 어댑터 종료는 모든
픽셀 버퍼와 signal listener를 버리고 WIC factory, vtable binding과 소유 COM 초기화를
정리한다. 반복 해제와 반복 종료는 안전하다. 네이티브 동기 codec 호출을 중간에
중단하지는 않으며 호스트가 취소된 결과를 폐기한다.

UI STA에 균형 잡힌 `CoInitializeEx`/`CoUninitialize`와 WIC factory를 소유한다.
Windows Imaging Component는 명시적으로 선택한 PNG, JPEG 또는 BMP decoder만
사용한다. encoded 입력은 600,000바이트, decode 결과는 524,288바이트로 제한하고
크기를 확인한 뒤 픽셀을 할당한다. frame, converter, encoder, bitmap과 stream의 COM
reference는 각 호출의 `finally`에서 역순으로 해제한다. 호출 사이에는 RGBA 픽셀 복사본만
보유하며 네이티브 interface pointer를 리소스 ID에 넣지 않는다.

쓰기는 고정 크기의 600,000바이트 WIC memory stream을 사용한다. native encoder의
container 종료 위치를 확인해 padding을 제거한 복사본만 반환한다. PNG는 alpha를
보존한다. JPEG와 BMP는 불투명 픽셀만 받으며 배경색을 임의로 적용하지 않는다.
색상 profile과 EXIF metadata를 보관하거나 orientation을 자동 적용하지 않는다.

ABI와 GUID는 Microsoft의 [WIC SDK header](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/wincodec.h),
[native pixel format](https://learn.microsoft.com/en-us/windows/win32/wic/-wic-codec-native-pixel-formats)과
[encoding 계약](https://learn.microsoft.com/en-us/windows/win32/wic/-wic-creating-encoder)을 따른다.
Linear resize는 [WIC scaler](https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapscaler-initialize)를 사용한다.

## macOS arm64 어댑터

`native/macos` 출력은 ImageIO로 PNG, JPEG와 BMP를 디코딩하고 인코딩한다.
CoreGraphics와 Accelerate의 시스템 framework만 Bun FFI로 호출하며 별도 dylib,
C 컴파일러와 clipboard 접근을 요구하지 않는다. native 리소스와 framework binding은
codec이 소유하고 각 호출의 Create/Copy reference를 역순으로 해제한다.
호출 사이에는 공통 `ImageResources`가 분리된 straight RGBA 버퍼만 보유한다.

입력 MIME과 실제 UTI, 단일 frame과 완전한 데이터 상태를 확인한다. ImageIO metadata의
크기를 먼저 검사하고 cache를 끈 채 이미지를 생성한다. vImage는 상한 안에서 할당한
RGBA 버퍼에 직접 변환하므로 PNG의 alpha와 투명 RGB를 premultiplied 변환으로 잃지 않는다.
JPEG와 BMP의 불투명 입력 제한, 빈 이미지와 quota는 Windows와 같은 계약을 따른다.
ImageIO 기본 품질로 JPEG를 인코딩하며 native 출력은 복사 전에 encoded 상한을 확인한다.

Crop과 nearest는 공통 픽셀 복사를 사용한다. Linear는 CoreGraphics의 low interpolation과
premultiplied RGBA context를 사용하고 결과를 straight RGBA로 변환한다.
CGRect를 네 개의 double로 전달하는 ABI는 arm64 전용이며 x64는 `UNSUPPORTED`다.

어댑터 실행 위치는 `io`이며 호스트가 요청 권한, signal과 `beforeExecute`를 보유한
`executeUI` contextual hook으로 호출해야 한다. 이름과 달리 이 hook은 AppKit나
UI 스레드에 의존하지 않는다. context 없이 호출하는 `execute`는 `UNSUPPORTED`다.
macOS 호스트의 공통 I/O Worker가 등록한 image 어댑터만 초기화하고 이 hook으로
권한과 취소를 전달한다. 앱 종료는 I/O Worker에서 모든 이미지와 codec binding을 정리한다.

## 검증

```powershell
mise exec -- bun test tests/api/image.test.ts tests/lifecycle/image-resources.test.ts
mise exec -- bun test tests/lifecycle/image-crop.test.ts
mise exec -- bun test tests/lifecycle/windows-image.test.ts
mise run host:windows
```

일반 검사는 계약, canonical base64와 크기 상한, operation 권한, browser 출력의 FFI 제외,
빈 이미지, ID 수명, count와 메모리 quota, 생성 취소와 반복 종료를 확인한다.
Windows 검사는 실제 UI Worker와 WIC에서 RGBA, PNG와 data URL의 alpha 왕복,
JPEG와 BMP 인코딩, 잘못된 입력과 decode 크기, 최대 크기의 PNG, 정책 거부,
결과 전달 전 취소와 앱 종료를 검사하며 `host:windows`에 포함한다.
WebView 페이지 표시, 다른 앱의 가져오기, 색상 관리, 하드웨어나 최소 Windows 버전의
검증을 뜻하지 않는다. 정확한 head CI 결과는 해당 PR에서 확인한다.

macOS 전용 `tests/lifecycle/macos-image.test.ts`는 실제 framework로 RGBA와 PNG의
alpha 및 투명 RGB 왕복, grayscale과 palette PNG, JPEG/BMP, malformed 입력과 decode
크기, crop/resize, 앱별 ID, 권한, quota, 생성 취소와 반복 종료를 검사한다.
`tests/cli/image.test.ts`는 tarball을 isolated 설치해 neutral, Windows와 macOS 출력의
분리와 browser FFI 제외를 확인하고 macOS arm64에서 설치된 native adapter를 실행한다.
`macos-image.yml`은 이 검사와 기존 entitlement로 ad-hoc 서명한 compiled codec fixture를
실행한다. 실제 shared 호스트 dispatch와 WKWebView 공개 호출은 아래 호스트 fixture에서 검증한다.

`tests/lifecycle/macos-image-host.ts`는 실제 compiled 호스트와 WKWebView 명령에서
공개 backend image SDK를 호출하는 성공 전용 fixture다. Backend setup과 뷰 명령,
RGBA/PNG와 JPEG/BMP, crop/resize, 동일 ID의 작업별 권한, 해제와 정상 종료를 검사하고 `build/macos-image-host-results.json`을 기록한다.
`host:macos`의 shared runner에 포함되며 contextual I/O dispatch를 실제로 사용한다.
호스트 기반은 [PR #164](https://github.com/mathbook3948/bunaway/pull/164)의 별도 변경에 둔다.
각 head의 실행 결과는 PR의 native CI에서 확인한다.
