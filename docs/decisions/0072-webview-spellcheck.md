---
status: accepted
---

# WebView 맞춤법 검사 관리와 misspelling 조회, 교체 API를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. Electron v45 기준이다.

앱이 맞춤법 검사의 활성화, 언어, dictionary와 사용자 단어를 관리하고, 틀린 단어와 추천 단어를 조회해 교체하는 API를 제공할지 정해야 했다.

- Electron의 `session`은 `setSpellCheckerEnabled`, `setSpellCheckerLanguages`, `listWordsInSpellCheckerDictionary`,
  `addWordToSpellCheckerDictionary`, `removeWordFromSpellCheckerDictionary`, `setSpellCheckerDictionaryDownloadURL`을 제공한다. 틀린 단어와
  추천 단어는 `context-menu` 이벤트의 `misspelledWord`, `dictionarySuggestions`로 받고, `webContents.replaceMisspelling`으로 바꾼다. Windows와
  Linux에서는 Hunspell 사전을 내려받아 쓰며, 앱이 컨텍스트 메뉴를 직접 만들 때 이 값들이 필요하다.
- Tauri와 wry는 맞춤법 검사 API를 제공하지 않는다. 앱은 WebView의 기본 동작에 맡긴다.
- WebView2 호스트 API에서는 맞춤법 검사 켜기와 끄기, 언어, 사용자 사전을 다루는 인터페이스를 찾지 못했다. 편집 가능한 요소의 검사는 런타임이
  기본으로 처리하고, 기본 context menu(`AreDefaultContextMenusEnabled`)가 켜져 있으면 추천 단어와 "사전에 추가"가 거기에 나타난다.
  `ContextMenuRequested`의 메뉴 항목에 맞춤법 관련 항목이 포함되는지는 확인하지 못했다. 사전과 사용자 단어는 런타임이 사용자 데이터 폴더와
  OS 설정에서 관리하므로 앱이 소유한 상태가 아니다.
- 이 저장소는 기본 context menu를 켜는 설정을 추가하지 않고 앱이 메뉴 플러그인의 `showContextMenu`로 메뉴를 만든다([ADR 0064](./0064-webview-browser-default-ui.md)).
  메뉴 role은 undo, redo, cut, copy, paste, select-all까지만 제공하고 selection 변경과 텍스트 교체 API는 제공하지 않는다([ADR 0050](./0050-webview-edit-commands-and-selection.md)).
  그래서 이 저장소의 앱에서는 기본 맞춤법 메뉴가 뜨지 않는다.

## 결정

1. 맞춤법 검사의 활성화, 언어, dictionary, 사용자 단어를 관리하는 API를 추가하지 않는다.
2. misspelling 조회, suggestion, 교체 API를 추가하지 않는다. 맞춤법 교정 UI가 필요한 앱은 페이지 안에서 직접 구현하거나 자체 사전을 쓴다.
   페이지 편집 영역의 `spellcheck` 속성은 웹 표준대로 동작한다.
3. WebView2가 맞춤법 호스트 API(검사 설정, 틀린 단어와 추천 단어의 전달)를 제공하게 되거나 쓰는 앱이 생기면 별도 결정에서 다룬다. 이때
   Windows와 macOS의 사전 소유와 언어 목록의 차이를 먼저 정한다.

## 근거

- Electron은 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다. 쓰는 곳이 없다(`plugins`,
  `packages`, `examples`에 맞춤법 검사를 쓰는 코드는 없다).
- Electron의 API 대부분은 Chromium 내장 검사기를 전제로 한다. WebView2에서는 호스트가 같은 범위를 약속할 수 없어서(위 호스트 API 부재) 같은
  이름의 API가 플랫폼마다 다른 범위를 약속하게 된다.
- 교체는 selection 변경과 텍스트 삽입 API를 제공하지 않는 결정(ADR 0050)과 충돌한다. 단독으로 열면 그 결정의 범위가 달라진다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시하고 이 결정을 참조한다.
