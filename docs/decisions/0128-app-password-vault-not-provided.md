---
status: accepted
---

# 앱 암호로 여는 Stronghold 방식 vault는 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `c5df26d4`.

## 배경

Tauri의 `plugin-stronghold`는 앱 전용 암호화 vault를 준다. 이 vault는 앱이 정한 암호로 열고, 안에 client, store record와
key를 두며, vault 파일을 저장한다. TODO는 같은 범위를 네 가지로 나누어 지원 여부를 묻는다.

- vault, client, key와 record 관리.
- vault unlock, lock, save와 암호 변경.
- 키 생성과 cryptographic operation을 secret 노출 없이 실행.
- vault 암호 파생 함수와 salt의 설정, 생성과 보관.

비교 기준은 다음과 같다.

- Tauri `plugin-stronghold`는 IOTA Stronghold 엔진을 감싼다. 앱이 vault 파일 경로와 암호를 넘겨 열고, 암호는 Rust 쪽에서
  앱이 고른 해시 함수(예: argon2와 salt 파일)로 키로 바뀐다. 암호 파생과 salt 보관은 플러그인 설정이며 기본값이 없다.
- Electron `safeStorage`는 OS 키(Windows DPAPI, macOS Keychain, Linux secret store)로 문자열을 암호화하고 복호화하는
  것이 전부다. 앱 암호로 여는 vault, record 관리, 키 생성 연산은 없다. 암호문을 둘 위치는 앱이 정한다.
- 위 Tauri와 Electron 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
- 이 저장소에는 `safe-storage`가 있다. `encryptString`, `decryptString`, `encryptBytes`, `decryptBytes`는 Windows에서
  current-user DPAPI로 보호하고, `setSecret`, `getSecret`, `deleteSecret`은 자격 증명 관리자에 항목을 저장한다. 암호문을 둘 위치는
  앱이 정한다. 앱 암호나 추가 entropy는 받지 않는다.
- 앱 백엔드는 Bun 프로세스이며 신뢰된 코드다. Bun이 제공하는 WebCrypto(`crypto.subtle`의 PBKDF2, HKDF, AES-GCM, ECDSA,
  Ed25519 등)와 `crypto.getRandomValues`, 그리고 앱이 고른 검증된 라이브러리를 직접 쓸 수 있다. 지원 알고리즘은 Bun 공개
  문서에 따른 것이며 이 저장소 테스트로 검증한 것은 아니다.

## 결정

1. vault, client, key, record 관리 연산을 코어나 플러그인의 공개 연산으로 제공하지 않는다.
2. vault unlock, lock, save와 암호 변경을 제공하지 않는다.
3. 앱 암호 기반 키 생성과 cryptographic operation 연산을 제공하지 않는다.
4. 암호 파생 함수와 salt의 설정, 생성과 보관 연산을 제공하지 않는다.
5. 새 `UNSUPPORTED` 항목이나 설정 키를 만들지 않는다. 제공하는 공개 연산이 없으므로 표시할 대상이 없다.
6. 코드, 테스트와 공개 계약은 바뀌지 않는다.

앱이 필요한 보호 수준에 따라 다음을 쓴다.

- 작은 비밀(토큰, 비밀번호): `safe-storage`의 `setSecret`, `getSecret`, `deleteSecret`. 자격 증명 관리자가 현재 사용자 범위로
  보관한다. 같은 사용자의 다른 프로세스도 조회할 수 있어 앱별 격리는 없다.
- 파일이나 값을 현재 사용자 키로 보호: `safe-storage`의 `encryptString` 등으로 암호화한 뒤 암호문을 `storage`에 저장한다.
- 앱 정의 암호가 필요한 데이터: 앱 백엔드가 WebCrypto로 암호를 파생(PBKDF2 등)하고 AES-GCM으로 암호화한 뒤 `storage`에
  저장한다. 암호 입력 UI, 파생 함수 매개변수, salt 보관, 암호 변경 시 재암호화는 앱이 정한다.

## 근거

- Electron은 vault를 제공하지 않고 OS 키 기반 암호화만 준다. 이 저장소의 `safe-storage`가 같은 범위를 이미 제공하며 Windows
  자격 증명 관리자 항목까지 더했다. vault는 Tauri에만 있는 기능이므로 두 선례가 다르고, 그럴 때는 Electron 쪽을 따르고 코어를 작게 둔다.
- 앱 암호로 여는 vault는 파생 함수와 매개변수 선택, salt와 vault 파일 형식의 버전 관리, 잠금 해제 UI와 실패 횟수 정책,
  암호 변경 시 전체 재암호화, 암호 분실 복구 같은 보안 설계를 프레임워크가 소유하게 만든다. 형식이나 매개변수 결함은 모든
  앱의 저장 데이터에 영향을 주고 한 번 정한 형식은 바꾸기 어렵다.
- 키 생성과 암호 연산은 Bun의 WebCrypto가 이미 제공한다. 신뢰된 백엔드가 직접 쓰므로 키와 암호 연산이 백엔드 안에서
  끝난다(암호를 입력받는 UI가 있으면 그 값은 앱이 정한 경로로 백엔드에 전달된다). 이를 IPC 연산으로 감싸면 화면에서 호출 가능한 암호 연산이 생겨 권한과 경계 설계가 새로 필요하다.
- Stronghold 엔진은 별도 Rust 의존성이며 Windows에서 네이티브 빌드와 메모리 잠금 동작을 호스트가 책임져야 한다. 이 서술은 공개
  문서 기준이며 이 저장소 테스트로 검증한 것은 아니다. 쓰는 앱이 정해지지 않은 상태에서 이 부담을 지지 않는다.

## 대안

- vault를 플러그인으로 제공: 코어 계약은 늘지 않지만 위 보안 설계 책임이 플러그인에 그대로 남는다. 쓰는 앱이 없는 지금은 보류한다.
- 앱 암호 기반 암호화 helper만 제공(파생과 AES-GCM 래퍼): WebCrypto 호출 몇 줄을 감싸는 것에 그친다. 매개변수를 고정하면 나중에
  바꾸기 어렵다.
- 앱 정의 암호를 DPAPI optional entropy로 함께 쓰기: `safe-storage`의 현재 계약은 entropy를 받지 않는다. 필요가 확인되면
  `safe-storage` 계약 확대 항목으로 따로 다룬다.

## 결과

- 코드와 공개 계약은 바뀌지 않는다.
- TODO-windows의 해당 네 줄을 `[x] 결정 완료`로 바꾸고 이 결정을 가리킨다.
- 앱 정의 암호가 필요한 앱은 결정 절의 앱 정의 암호 안내를 따른다. 이 안내는 문서이며 이 저장소 테스트로 검증한 동작이 아니다.
- `safe-storage`는 같은 사용자의 다른 프로세스가 복호화하거나 조회할 수 있고 앱별 격리를 제공하지 않는다. 이 한계가 받아들여지지
  않는 데이터는 앱 정의 암호로 보호해야 한다.
