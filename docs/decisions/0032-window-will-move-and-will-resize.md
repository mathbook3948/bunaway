---
status: accepted
---

# 창 이동과 크기 조절을 앱 코드가 취소하는 will-move, will-resize를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `fc249c56`.

## 배경

사용자가 창을 끌어 이동하거나 크기를 조절하기 전에 앱이 그 변경을 취소하거나 수정하는 이벤트(`will-move`,
`will-resize`)를 제공할지 정해야 했다.

- Electron 45는 `will-move`와 `will-resize`를 macOS와 Windows에서만 제공한다(Linux 없음). 사용자가 직접
  조작할 때만 발생하고 `setBounds`, `setSize`, `setPosition`, `center` 호출로는 발생하지 않는다.
  `will-resize`는 Windows와 macOS에서 `preventDefault()`로 취소된다. `will-move`는 Windows에서만 취소되고
  macOS에서는 취소할 수 없다. 취소 여부는 리스너가 동기로 반환하는 시점에 정해지며, 나중에 비동기로
  `preventDefault()`를 불러도 효과가 없다. Windows의 구현 위치는 `WM_MOVING`, `WM_SIZING`이다.
- Tauri 2는 이동과 크기 조절의 사전 취소 이벤트와 API가 없고 `WindowEvent::Moved`, `Resized`를 이미 일어난 뒤에만
  알린다. 취소할 수 있는 창 이벤트는 `CloseRequested`의 `prevent_close()`뿐이며, 막으려면 최소, 최대 크기와
  `resizable` 같은 사전 제약을 쓰거나 사후에 되돌려야 한다.
- 이 저장소는 끄는 도중에 `move`, `resize`를, 사용자 조작이 끝난 뒤에 `moved`, `resized`를 `windows.changed`로
  제공한다. 사용자 조작 하나는 `WM_ENTERSIZEMOVE`와 `WM_EXITSIZEMOVE` 사이로 추적한다.
- Windows 창 프로시저는 이동 중에 `WM_MOVING`, 크기 조절 중에 `WM_SIZING`을 포인터 이동마다 동기적으로 받고,
  메시지가 가리키는 RECT를 고쳐 쓰는 것으로 결과를 정한다(Win32 문서 기준이며 `WM_MOVING`은 이 저장소에서 처리하지
  않는다). 호스트는 이미 `WM_SIZING`에서 가로세로 비율 고정(`setAspectRatio`)을, `WM_GETMINMAXINFO`에서 최소,
  최대 크기 제한을 같은 방식으로 적용한다.
- 앱 코드는 호스트 창 프로시저와 다른 곳(백엔드 또는 WebView)에서 실행되고, 앱 코드의 응답은 IPC를 거치는
  비동기 메시지다. 닫기 요청은 이산적인 사건이라 `windows.closeRequested`와 `windows.respondClose`로 응답을
  기다릴 수 있지만, 이동과 크기 조절은 사용자가 끄는 동안 메시지가 연속으로 온다.

## 결정

1. `will-move`와 `will-resize` 같은 앱 코드 응답 대기형 취소 이벤트와 그에 응답하는 API는 제공하지 않는다.
2. 크기에 대한 제약은 선언형 설정으로 둔다. 이미 제공하는 `setMinSize`, `setMaxSize`, `setSizeConstraints`는
   `WM_GETMINMAXINFO`에서, `setAspectRatio`는 `WM_SIZING`에서 적용된다. 비율 고정은 사용자가 가장자리를 끌 때만
   맞추므로 최대화와 전체화면에는 적용되지 않는다. 이동 범위를 제한하는 선언형 옵션은 지금 제공하지 않는다.
3. 이동과 크기 조절의 결과를 바꿔야 하는 앱은 조작이 끝난 뒤 받는 `moved`, `resized`에서 `setPosition`,
   `setOuterSize`로 보정한다. 두 이벤트의 bounds는 바깥 크기이므로 내용 영역 크기를 받는 `setSize`가 아니라
   바깥 크기를 받는 `setOuterSize`와 짝이 맞는다. 끄는 도중의 `move`, `resize`는 사용자 조작이 계속되는
   중간 값이라 권고로 보정 대상에서 뺐으며, 호스트가 막는 것은 아니다. 이 경로는 이미 반영된 변경을
   되돌리므로 사전 취소가 아니라는 점을 문서에 적는다.
4. 사전 취소가 실제 요구로 확인되면 앱 응답을 기다리지 않는 선언형 이동 제한(작업 영역, 모니터 안쪽 유지 등)
   형태로 별도 결정에서 다룬다.

## 근거

- 동기 창 프로시저에서 앱 코드의 IPC 응답을 기다리면 사용자가 끄는 동안 창 메시지 처리가 그 응답 시간만큼
  멈출 것으로 본다. 측정한 값이 아니라 창 프로시저가 동기 반환값을 요구한다는 Win32 계약에서 낸 추정이다.
  이동과 크기 조절은 포인터 이동마다 반복되므로 지연이 누적되고, 기한을 두면 기한 초과 때 어느 쪽으로
  처리할지가 별도로 필요하다. 호스트가 지금 쓰는 크기 제약은 응답을 기다리지 않는 선언형이라 이 문제가 없다.
- 두 프레임워크가 다르다. Electron은 취소를 동기 리스너 반환으로 받는데 `will-move`는 macOS에서 취소할 수 없어
  플랫폼마다 계약이 갈리고, Tauri에는 없다. 이 저장소에서 이동과 크기 조절에 사전 취소를 쓰는 곳은 없다(닫기
  요청만 응답을 기다린다). 사용처가 없는 기능으로 코어 계약을 늘리지 않고, 필요한 제약은 Tauri처럼 선언형
  설정으로 둔다.
- Electron의 취소 가능한 `will-resize`가 덮는 용도(최소 크기, 비율 고정) 가운데 크기 쪽은 이미 선언형으로
  제공한다. 이동 범위 제한은 선언형 옵션이 없어 사후 보정으로 되돌릴 수 있을 뿐이며 사전 취소는 아니다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 창 이벤트 절에 사전 취소 이벤트가 없다는 점과 대안을 적는다.
- 이동 범위 제한이 실제 요구로 확인되면 별도 결정에서 다룬다.
