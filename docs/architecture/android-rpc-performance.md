# Android RPC 성능 개선

2026-10-10부터 main `5f730db`의 Android RPC 경로를 개선하며 Capacitor 8.5.3과 비교했다.
Java 중계 경로를 최적화해도 별도 Bun 왕복과 JSON 검사 비용이 남았다. 최종 구현은
WebView에서 Bun으로 직접 연결하고 Java에 문서 권한 발급과 회수, 프로세스 수명주기를 남긴다.

## 최종 직접 연결의 반복 비교

2026-10-11 최종 APK와 Capacitor를 세 회차 교차 실행했다. 아래 조건과 동일한 입력,
워밍업과 표본 수를 사용했으며 빌드와 전체 검사를 병행하지 않았다.
값은 전체 원시 표본의 중앙값 / p95, 단위는 ms다.

| 입력 / 동시 호출 | Bunaway 직접 연결 | Capacitor 8.5.3 |
| --- | ---: | ---: |
| 0 bytes / 1 | 1.20 / 4.40 | 1.10 / 1.90 |
| 1KiB / 1 | 1.10 / 2.90 | 1.40 / 2.20 |
| 16KiB / 1 | 1.10 / 2.30 | 1.80 / 2.70 |
| 128KiB / 1 | 4.60 / 7.10 | 5.80 / 10.50 |
| 1KiB / 16 | 3.70 / 6.40 | 4.90 / 9.10 |

1KiB, 16KiB, 128KiB와 동시 호출의 중앙값은 Capacitor보다 각각 약 21%, 39%, 21%, 24%
짧다. 128KiB의 회차별 중앙값은 4.3, 4.5, 5.0ms, 동시 호출은 3.4, 3.6, 4.2ms다.
빈 요청 중앙값은 0.1ms 길고, 빈 요청 및 1KiB의 p95도 여전히 길다.
따라서 모든 입력과 백분위에서 더 빠르다고 해석하지 않는다. 작은 입력의 느린 표본은
측정 구간 초반에도 나타나지만 이 자료만으로 JIT나 시작 부하가 원인이라고 단정할 수 없다.
별도 고정 주소 프로토타입의 수치는 이 최종 비교에 섞지 않았다.

원시 표본은 `measurements-20261011-003508/resume-comparison.json`이며 재현 명령은
`python build/android-performance/2026-10-10/resume-compare.py final capacitor`다.

| 변형 | APK SHA-256 |
| --- | --- |
| Bunaway 최종 직접 연결 | `cffb7a8a6aa09da9a33b070b34e30bcd9a3f820cf5906b6f7868ca726c3a7a97` |
| Capacitor | `56de010488dc11fbe71e8024d38efa82c3ec8b7386cf7fc1a8915f616cf18f3a` |

## 직접 연결의 구조

Capacitor는 WebView에서 실제 Java 명령 처리부로 바로 전달한다. Bunaway의 이전 경로는
`WebView → Java → 파이프 → Bun Core`이므로 같은 브리지 API를 사용해도 경계가 하나 더 있다.
현재는 native origin 검사로 일회용 주소를 받은 뒤 `WebView → loopback WebSocket → Bun Core`로
앱 메시지를 보낸다. 기존 SDK, 정책, 입출력 스키마와 명령 처리를 그대로 사용한다.
외부 서비스를 호출하는 서버가 아니라 `127.0.0.1`에만 바인딩하는 앱 내부 연결이다.

주소는 임시 포트와 난수 토큰으로 구성한다. 정확한 Host와 native에서 확인한 Origin을 검사하고
토큰은 한 연결에서만 사용한다. 세션 교체는 기존 토큰과 연결을 함께 회수한다.
미사용 주소의 10초 만료와 메시지 1MiB, 입력 대기 128개, 출력 버퍼 2MiB 제한을 둔다.
실패한 연결의 요청을 재전송하지 않는다. 압축, 묶음 전송과 응답 캐시는 추가하지 않았다.
앱 네트워크 설정이 loopback 연결을 막거나 listener 시작이 실패하면 MessagePort를 사용한다.
포트 API를 사용할 수 없으면 reply proxy로 전달한다.

실제 소켓 테스트로 출처 위조, 토큰 재사용과 만료, 회수, 늦은 SDK 생성, 잘못된 메시지와
큐 및 크기 제한을 확인했다. 실제 Bun 프로세스에서도 명령 오류의 비공개 정보 제거,
잘못된 origin 거부, 회수와 종료를 확인했다. Android 기본 APK와 loopback을 차단한 APK
모두 Core/SDK, 정책, 이벤트, 취소, 회전, 홈 복귀, 뒤로가기와 renderer 실패 정리를 통과했다.

## 이전 MessagePort 구현의 반복 비교

MessagePort 직접 응답, 완료 기한 감시, 종류 우선 검사와 파이프 복사 감소를 합친 결과다.
비교 대상 문자열 경로에도 Core 사전 검사와 앞선 문자열 검증 개선은 포함돼 있다.
아래 값은 세 회차 원시 표본을 합친 중앙값 / p95이며 단위는 ms다.
환경과 케이스별 워밍업 및 측정 횟수는 아래 측정 조건과 같다.

| 입력 / 동시 호출 | 문자열 경로 | MessagePort 직접 전달 | Capacitor |
| --- | ---: | ---: | ---: |
| 0 bytes / 1 | 2.80 / 9.20 | 2.60 / 8.40 | 1.40 / 2.20 |
| 1KiB / 1 | 2.30 / 3.40 | 1.90 / 3.00 | 1.50 / 3.20 |
| 16KiB / 1 | 3.60 / 7.80 | 2.90 / 6.00 | 1.80 / 3.10 |
| 128KiB / 1 | 12.25 / 17.60 | 10.60 / 15.00 | 5.70 / 10.10 |
| 1KiB / 16 | 9.45 / 16.10 | 7.80 / 14.90 | 4.60 / 9.80 |

이 구현의 128KiB 회차별 중앙값은 10.4, 10.6, 10.7ms이며 동시 호출은 7.6, 7.3, 9.3ms다.
Capacitor 대비 128KiB는 약 1.86배, 동시 호출은 약 1.70배 느리다.
이전 시점의 main 측정과 표본을 합치거나 개별 수정의 효과로 나눠 해석하지 않는다.
기기 내 계측에서는 큰 입력의 Java 파싱과 검증, envelope 생성 및 별도 Bun 왕복이 남아 있다.
따옴표와 줄바꿈 검색을 정규식으로 바꾼 후보는 전체 호출 이득이 뚜렷하지 않아 제외했다.

원본은 `measurements-20261010-235627/resume-comparison.json`이며 재현 명령은
`python build/android-performance/2026-10-10/resume-compare.py text direct capacitor`다.

| 변형 | APK SHA-256 |
| --- | --- |
| 문자열 경로 | `ce4105737b2fee005c3af0a144fae490f0750c59ced08f666e393876a9007020` |
| MessagePort 직접 전달 | `b8a6a31e745fa03861a6d0527f309a0591c9424219d60c683f1576111ed04fce` |
| Capacitor | `56de010488dc11fbe71e8024d38efa82c3ec8b7386cf7fc1a8915f616cf18f3a` |

## 변경한 실행 경로

- Android의 내부 텍스트 채널은 SDK가 이미 만든 JSON을 그대로 전달한다. 송신 시 브리지의
  stringify와 수신 시 브리지의 parse 및 SDK의 stringify를 제거했다. SDK의 송신 검증은
  유지하며 기존 structured-value 브리지와 이전 SDK도 지원한다.
- Java는 한 번 검증한 WebView payload를 원문으로 process envelope에 넣는다.
  호스트가 만든 metadata와 합친 스키마, 중첩 깊이와 크기를 검사하지만 payload의 Unicode
  재검사와 Gson 직렬화는 반복하지 않는다. 응답도 검증한 원문에서 root payload 구간을
  잘라 전달한다. 중복 키는 마지막 값을 택하며 이스케이프된 키도 같은 이름으로 인식한다.
- 공통 TypeScript 파서는 `JSON.parse`가 만든 독립된 트리에 깊이, Unicode, 숫자와
  스키마 검사를 적용한다. 이 트리를 다시 복사하거나 각 문자열을 직렬화하지 않는다.
  JavaScript 객체 입력의 getter, 순환 참조와 변경을 방어하는 스냅샷 검증은 유지한다.
  process 직렬화의 정책 검사는 같은 스냅샷을 사용해 두 번째 복사를 없앴다.
- 일반 ASCII 문자열은 UTF-8 크기가 코드 단위 길이와 같다는 점을 사용한다.
  이스케이프가 필요 없는 문자열의 JSON 크기는 길이에 따옴표 두 바이트를 더해 계산한다.
  한글, 이모지와 제어 문자 등은 기존 정확한 크기 계산과 Unicode 검사를 거친다.
- Java의 깊이 사전 검사는 문자열 내부를 `String.indexOf`로 건너뛴다.
  따옴표 앞 역슬래시의 홀짝으로 문자열 끝을 구분하며, JSON 구문은 기존 strict Gson이 검사한다.
  파싱 후 깊이, Unicode, 숫자와 스키마 검사도 유지한다.
- Unicode 검사는 일반 문자마다 검증 함수를 호출하지 않는다. 객체 키 검사를 위한 임시
  `JsonPrimitive`와 숫자 및 boolean의 불필요한 문자열 변환도 제거했다.
- 공통 TypeScript 검증기는 `maxLength`가 없으면 코드 포인트 배열을 만들지 않는다.
  제한이 있어도 UTF-16 길이로 이미 허용됨을 알 수 있으면 순회를 생략하고,
  그 외에는 코드 포인트를 제한까지만 센다. 문자열 제한과 Unicode 검증은 유지한다.
- Bun stdin의 envelope 검증과 JSON 직렬화는 기존 writer가 수행한다.
  WebView 입력의 JSON, 스키마, 방향과 최초 hello 검사도 같은 writer에서 순서대로 수행한다.
  UI 스레드는 최초 연결의 출처와 main frame을 확인한다. 문서 종료 시 대기 중인 입력은 버리고,
  유효한 hello 전이나 문서 종료 후에는 응답을 전달하지 않는다.
  stdout의 중첩 웹 메시지 원문도 reader가 준비한다.
- 문서 전용 MessagePort로 입력 callback과 응답을 UI 스레드 밖에서 처리한다.
  읽기 스레드가 응답을 직접 보내므로 전달용 작업 큐를 한 번 더 거치지 않는다.
  제어 프레임은 UI 적용을 기다려 이후 응답이 ready나 fatal을 앞지르지 않게 한다.
  포트 미지원 환경은 기존 reply proxy로 연결한다. 문서별 nonce로 이전 문서의 포트
  전달을 거부하고 문서 교체와 종료 시 포트를 닫는다.
- 한 타이머가 가장 오래된 프레임의 완료 기한을 감시한다. 완료한 호출마다 타이머를
  재생성하지 않으며 다음 프레임의 기한도 연장하지 않는다. 전달이 멈추면 별도 정리
  스레드가 프로세스 그룹과 파이프를 종료한다. 유휴 시 남은 타이머는 한 번 실행된 뒤
  사라지고 종료 시 즉시 해제된다.

검증과 프로세스 경계는 유지했다. 포트 연결 대기와 Bun 쓰기 큐에는 공유 pending 제한을 적용한다.

## 참고한 구현

[Capacitor 8.5.3 MessageHandler](https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/MessageHandler.java)는
입력을 `JSObject`로 읽고 Java 플러그인에 전달한 뒤 응답을 문자열로 보낸다.
[Bridge](https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/Bridge.java)의
플러그인 실행은 작업 스레드에 예약된다. Bunaway의 별도 Bun 프로세스 왕복에 해당하는 단계는 없다.
응답의 `postMessage` 호출 위치를 그대로 따르지는 않는다.
[AndroidX](https://github.com/androidx/androidx/blob/androidx-main/webkit/webkit/src/main/java/androidx/webkit/JavaScriptReplyProxy.java)는
이 API에 UI 스레드를 요구한다. Bunaway는 작업 스레드 호출을 지원하는
[WebMessagePortCompat](https://developer.android.com/reference/androidx/webkit/WebMessagePortCompat)을
사용하고 reply proxy fallback만 UI에서 호출한다.

Tauri는 로컬 checkout `30da1fd6e17de6107ecc850c95dfb16b5729f2dd`를 확인했다.
[Android 요청](https://github.com/tauri-apps/tauri/blob/30da1fd6e17de6107ecc850c95dfb16b5729f2dd/crates/tauri/scripts/ipc-protocol.js)은
요청 본문을 읽을 수 없는 플랫폼 제약 때문에 `postMessage`를 사용한다.
[응답 채널](https://github.com/tauri-apps/tauri/blob/30da1fd6e17de6107ecc850c95dfb16b5729f2dd/crates/tauri/src/ipc/channel.rs)은
직렬화된 JSON을 유지하고 작은 응답은 직접 전달하며 큰 응답은 fetch 경로로 가져온다.
Bunaway에도 원문을 전달 단계 사이에서 유지하는 원칙을 적용했다.
별도 fetch 채널은 이번 변경에 추가하지 않았다.

남아 있던 Java 검사 비용도 줄였다. 스키마 정규식은 초기화할 때 한 번 컴파일하고,
UTF-16 길이의 세 배가 크기 제한 이하면 크기 확인만을 위한 UTF-8 배열을 만들지 않는다.
제한 근처의 입력은 실제 UTF-8 크기를 계산한다. 1,024 코드 단위 이상인 문자열은
Android의 정규식 엔진으로 짝이 없는 surrogate를 검사하고 짧은 문자열은 기존 순회를 사용한다.
ASCII, 한글, 이모지와 잘못된 surrogate로 기기 내 비교를 수행한 뒤 이 경로를 선택했다.
Node Buffer의 줄바꿈 검색과 단일 청크 직접 디코딩으로 Bun 측 중간 복사도 줄였다.

Core의 명령 응답과 이벤트 사전 검사도 완성된 JSON 문자열을 만들고 버리지 않는다.
`validateMessage`가 독립 스냅샷의 스키마, 깊이와 정확한 직렬화 크기를 확인한다.
숫자, 이스케이프와 Unicode의 전송 크기를 그대로 계산하며 실제 전송 시 직렬화한다.

Java 스키마 검사는 메시지 종류가 다른 분기를 runtime ID와 버전 검사 전에 제외한다.
분할된 파이프 프레임은 누적 버퍼에서 직접 디코딩하고, 쓰기에서는 줄바꿈을 붙이려고
전체 JSON 문자열을 복사하지 않는다. 한 writer가 본문과 줄바꿈을 연속으로 기록한다.

## 전송 경로 후보 비교

`measurements-20261010-233309/resume-comparison.json`은 기기 재부팅 후 수행한
한 회차의 탐색 결과다. 위와 같은 입력과 워밍업을 사용했고 값은 중앙값, 단위는 ms다.

| 경로 | 1KiB 순차 | 128KiB 순차 | 1KiB 동시 16개 |
| --- | ---: | ---: | ---: |
| 현재 문자열 브리지 | 2.50 | 12.40 | 10.30 |
| MessagePort 후보 | 2.00 | 11.75 | 7.85 |
| 큰 응답 ArrayBuffer 후보 | 2.50 | 13.55 | 8.50 |
| 큰 응답 fetch 후보 | 2.70 | 21.40 | 11.65 |
| Capacitor | 1.50 | 6.20 | 6.80 |

MessagePort 후보는 Core 사전 검사 변경도 포함한다. 다른 세 Bunaway 후보에는 이 변경이
없으므로 차이 전체를 MessagePort의 기여로 해석하지 않는다. 후속 문자열 기준 APK에는
같은 Core 변경을 반영했다. 한 회차 결과만으로 동등 성능을 달성했다고 판단하지 않는다.
ArrayBuffer와 fetch는 8KiB 이상 응답에 적용했다. 현재 구조에서는 효과가 없어 채택하지 않았다.

이후 MessagePort를 본 코드에 적용하면서 문서 교체 시 포트 회수, 응답 순서와 전달 기한을
유지했다. 첫 구현의 별도 응답 큐는 제거하고 읽기 스레드에서 직접 보낸다.
재부팅 전 시스템 부하가 높았던 `measurements-20261010-232631/`의 수치는 채택 판단에서 제외했다.

## 측정 조건과 결과

Windows의 Pixel 8 API 36 x86_64 에뮬레이터, WebView 154.0.8037.106,
Bun 1.4.2, debug APK를 사용했다. 같은 HTML, echo 입력과 결과 검사를 사용한다.
payload는 ASCII `x`를 지정한 바이트 수만큼 반복한 문자열이다.
한글과 이모지는 정확성 검사에 포함했지만 별도 성능 수치로 측정하지 않았다.
Bunaway는 Core 정책과 스키마, 별도 Bun 프로세스를 거치며 Capacitor는 Java 플러그인에서
echo를 반환한다. 내부 계약과 실행 경로까지 같은 비교는 아니다.

각 변형은 새로 설치하고 사전 시작한 뒤 측정했다. 순서는 수정 전, 수정 후, Capacitor와
그 역순을 세 회차에 걸쳐 교대로 사용했다. 각 케이스는 워밍업 30회 후 측정하며,
0 및 1KiB 순차 호출 150회씩, 16KiB 120회, 128KiB 60회, 1KiB 동시 호출 240회다.
변형마다 측정 2,160회와 워밍업 450회를 수행하고 모든 응답과 표본 수를 검사했다.
측정 중 빌드나 전체 검사를 병행하지 않았다. 파일시스템과 WebView 캐시는 지우지 않았다.

아래는 1차 수정의 세 회차 원시 표본을 합친 중앙값 / p95, 단위는 ms다.

| 입력 / 동시 호출 | 수정 전 | 수정 후 | Capacitor |
| --- | ---: | ---: | ---: |
| 0 bytes / 1 | 3.10 / 28.10 | 3.20 / 31.10 | 1.30 / 3.60 |
| 1KiB / 1 | 3.00 / 5.00 | 2.50 / 4.40 | 1.40 / 2.40 |
| 16KiB / 1 | 5.90 / 10.50 | 4.20 / 9.30 | 1.90 / 3.10 |
| 128KiB / 1 | 27.45 / 32.20 | 15.25 / 20.50 | 6.30 / 10.40 |
| 1KiB / 16 | 16.70 / 24.70 | 11.30 / 16.90 | 4.40 / 10.30 |

빈 payload의 중앙값과 p95는 개선되지 않았다. 16KiB 중앙값은 28.8% 줄었다.
128KiB의 회차별 중앙값은 수정 전 26.1, 28.7, 27.0ms, 수정 후 15.2, 14.9, 15.7ms다.
동시 호출은 수정 전 16.6, 16.5, 16.8ms, 수정 후 12.0, 10.7, 11.2ms다.
수정 후에도 Capacitor 대비 128KiB는 약 2.4배, 동시 호출은 약 2.6배 느리다.
Core와 직접 호출 가능한 command의 입출력 검사는 각각 유지한다.
Java의 최초 파싱과 검증, 별도 Bun 프로세스 왕복도 남아 있다.
이 수치는 위 변경을 합친 효과이며 개별 최적화의 기여도를 분리한 결과는 아니다.

이후 정규식 사전 컴파일, 파이프 복사 감소와 WebView 입력의 writer 검증을 적용한
추가 비교에서는 수정 APK / Capacitor 중앙값이 1KiB 2.50 / 1.40ms,
128KiB 14.75 / 6.10ms, 1KiB 동시 16개 10.30 / 4.90ms였다.
세 회차 원본은 `measurements-20261010-231213/resume-comparison.json`이다.
기존 1차 결과와 실행 시점이 다르므로 수치를 합치지 않는다.

그 뒤 UTF-8 크기 사전 판정과 긴 문자열의 Unicode 검사 경로를 추가했다.
이 단계만 분리한 비교는 ADB 서버 연결 실패로 중단되어 완성된 세 회차 수치가 없다.
중단된 실행 `measurements-20261010-231613/`은 최종 성능 근거에서 제외한다.
이 변경은 문서 앞부분의 이전 MessagePort 구현 반복 비교에 포함돼 있다.

## 로컬 재현 자료

`build/android-performance/2026-10-10/`에 기존 공통 `harness.js`, `prepare.ts`,
`run-benchmark.py`와 이번 `resume-compare.py`를 보관했다. 이 디렉터리는 Git 추적 대상이 아니다.
`resume-baseline/app-debug.apk`, `resume-candidate/app-debug.apk`와 Capacitor APK를 준비한
현재 로컬 환경에서 `python build/android-performance/2026-10-10/resume-compare.py baseline candidate capacitor`로
동일 측정을 수행한다. 스크립트는 측정 패키지만 교체하고, 공간 확보를 위해 검증 fixture를
데이터를 보존한 채 임시 제거한 뒤 finally에서 복원한다. 다른 앱은 제거하지 않는다.

1차 비교 원시 표본은 `measurements-20261010-225331/resume-comparison.json`이다.
1차 비교 APK SHA-256은 다음과 같다.

| 변형 | SHA-256 |
| --- | --- |
| 수정 전 | `caa818dc53f4551264d1cf31db2a9de960c325bb2b35df72b99f6fc6e504d400` |
| 수정 후 | `f7b88335aaffa8efb7cb15ca0c3216e7cf914954db67278921baa5395baf80bf` |
| Capacitor | `56de010488dc11fbe71e8024d38efa82c3ec8b7386cf7fc1a8915f616cf18f3a` |

저장 공간 부족으로 중단된 예비 실행은 제외했다. 응답마다 타이머를 만든 후보와
짧은 문자열에도 Unicode 정규식을 사용한 후보는 1차 수치에 포함하지 않았다.
ARM64 실기기, release APK, 배터리와 장시간 최대 용량 부하는 측정하지 않았다.
이 수치는 에뮬레이터의 해당 echo 부하에 대한 결과다.
