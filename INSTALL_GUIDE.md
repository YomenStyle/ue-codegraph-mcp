# UE CodeGraph MCP — 설치 및 사용 가이드

Unreal Engine C++ 코드베이스를 SQLite DB에 인덱싱하고,
Claude Code에서 호출 그래프·클래스 분석·include 의존성 등을 조회하는 MCP 서버입니다.

---

## 사전 요구사항

| 항목 | 버전 | 확인 명령 |
|------|------|-----------|
| **Node.js** | **22 LTS** | `node --version` |
| **npm** | 9 이상 | `npm --version` |
| **Claude Code** | 최신 | `claude --version` |

> **중요:** Node.js **22 LTS** 버전을 사용하세요.
> v25 등 Current(홀수) 버전은 tree-sitter 네이티브 모듈과 호환되지 않아 파싱이 실패합니다.

---

## 설치

### 1. Node.js 22 LTS 설치

```powershell
# 현재 버전 확인
node --version
```

- **v22.x.x** → 2단계로 진행
- **v25 등 다른 버전** → 아래 절차대로 교체
- **Node.js 미설치** → 아래 절차대로 신규 설치

#### 기존 Node.js 제거 후 v22 설치

```
1. Windows 설정 → 앱 → "Node.js" 검색 → 제거
2. https://nodejs.org 접속 → "LTS" 탭 클릭 → 다운로드 (v22.x.x)
3. 다운로드된 .msi 파일 실행 → Next 반복 → 설치 완료
4. 터미널을 새로 열고 확인:
```

```powershell
node --version
# v22.x.x 가 나와야 합니다
```

> `winget` 사용자는 한 줄로 가능:
> ```powershell
> winget install OpenJS.NodeJS.LTS
> ```

### 2. setup.bat 실행

```powershell
cd C:\Tools\ue-codegraph-mcp
.\setup.bat
```

**setup.bat이 자동으로 처리하는 것:**
1. Node.js / npm 버전 확인 (v22 LTS가 아니면 에러 안내)
2. `npm install -g node-gyp` — 네이티브 빌드 도구 설치
3. `npm install` — 의존성 설치 (tree-sitter, better-sqlite3 네이티브 빌드 포함)
4. `npm link` — `ue-graph` 글로벌 명령어 등록 (이후 어디서든 사용 가능)
5. UE 프로젝트 Source 경로를 입력하면 `mcp.json` 자동 생성 + 인덱싱까지 실행

> 네이티브 빌드 에러가 나면 아래 "트러블슈팅" 섹션을 참고하세요.

### 3. 인덱싱

```powershell
ue-graph index "G:\YourProject\Source" ue-project
```

출력 예시:
```
Indexing G:\YourProject\Source as "ue-project" (project)...

Done!
  Files: 1784 (new: 1784, changed: 0)
  Symbols: 45623
  UE Macros: 3210
  Calls: 28450
  Includes: 9120
  Time: 32.5s
```

### 4. 확인

```powershell
ue-graph status
```

```
[1] ue-project (project)
    Path: G:\YourProject\Source
    Files: 1784 | Symbols: 45623 | Macros: 3210
    Last indexed: 2026-03-04 14:08:48
```

---

## Claude Code에서 사용하기

### MCP 서버 등록 (글로벌 — 모든 프로젝트에서 사용)

아래 명령어로 MCP 서버를 **글로벌 등록**하면, 어떤 프로젝트에서든 Claude Code가 자동으로 인식합니다.

```powershell
claude mcp add -s user ue-codegraph node "C:\ue-codegraph-mcp\build\index.js"
```

> **경로는 본인의 설치 경로에 맞게 수정하세요.**
> 예: `C:\Tools\ue-codegraph-mcp\build\index.js`

등록 확인:

```powershell
claude mcp list
```

> setup.bat의 4단계에서 프로젝트별 `mcp.json`을 생성하는 기능이 있지만,
> 글로벌 등록을 했다면 `mcp.json` 없이도 모든 프로젝트에서 사용 가능합니다.

### 사용하기

UE 프로젝트 폴더에서 Claude Code를 실행합니다:

```powershell
cd G:\YourProject
claude
```

`/mcp` 입력으로 `ue-codegraph` 서버가 연결되었는지 확인한 뒤,
자연어로 질문하면 Claude가 MCP 도구를 자동으로 사용합니다.

**질문 예시:**
- "SetHP 함수를 호출하는 곳 찾아줘"
- "DamageMyPlayer에서 SetHP까지 호출 경로 추적해줘"
- "UAMirLuaManager 클래스 분석해줘"
- "AMirCharacter.h를 include하는 파일들 알려줘"

---

## CLI 명령어 (터미널에서 직접 사용)

Claude Code 없이도 터미널에서 바로 조회할 수 있습니다.

### 인덱스 관리

```powershell
# 코드베이스 인덱싱
ue-graph index "G:\YourProject\Source" ue-project

# 인덱싱 상태 확인
ue-graph status

# 단일 파일 재인덱싱 (파일 수정 후)
ue-graph reindex "G:\YourProject\Source\MyGame\Public\MyActor.h"

# 코드베이스 삭제
ue-graph delete ue-project
ue-graph delete all
```

### 호출 그래프 (가장 유용)

```powershell
# SetHP를 호출하는 모든 함수
ue-graph callers SetHP

# BeginPlay가 호출하는 함수들
ue-graph callees BeginPlay

# DamageMyPlayer → SetHP 호출 경로 추적
ue-graph chain DamageMyPlayer SetHP
```

### 클래스 분석

```powershell
# 클래스 상세 분석 (메서드, 프로퍼티, UE매크로)
ue-graph analyze UAMirLuaManager

# 상속 계층 조회 (부모 + 자식)
ue-graph hierarchy AAMirCharacter
```

### 검색

```powershell
# 심볼 이름 검색 (FTS, 시그니처 포함)
ue-graph search "SetHP"

# 코드 텍스트 패턴 검색
ue-graph code "CL2LG_MY_CHARACTER_SPAWN_REQ"

# 심볼 참조 위치 검색
ue-graph refs DamageMyPlayer
```

### UE 매크로

```powershell
# 모든 UFUNCTION 매크로 검색
ue-graph macros UFUNCTION

# BlueprintCallable 스펙이 있는 UFUNCTION만
ue-graph macros UFUNCTION BlueprintCallable

# 특정 클래스의 Blueprint 인터페이스
ue-graph blueprint UAMirLuaManager
```

### 파일 의존성

```powershell
# include 그래프 (이 파일이 뭘 include하고, 누가 이 파일을 include하는지)
ue-graph deps "G:\YourProject\Source\MyGame\Public\MyActor.h"
```

---

## 전체 명령어 요약

```
ue-graph <command> [arguments]

인덱스:
  index <path> [name]        코드베이스 인덱싱
  status                     인덱싱 상태 조회
  reindex <file_path>        단일 파일 재인덱싱
  delete <id|name|all>       코드베이스 삭제

분석:
  analyze <class_name>       클래스 상세 분석
  hierarchy <class_name>     상속 계층 조회
  blueprint [class_name]     Blueprint 노출 조회

호출 그래프:
  callers <function_name>    호출자 검색
  callees <function_name>    피호출자 검색
  chain <from> <to>          호출 체인 탐색

검색:
  search <query>             심볼 검색 (FTS)
  code <pattern>             코드 패턴 검색
  refs <symbol_name>         심볼 참조 검색

매크로/의존성:
  macros [type] [specifier]  UE 매크로 검색
  deps <file_path>           파일 의존성 조회
```

---

## 알려진 제한사항

| 항목 | 설명 | 대안 |
|------|------|------|
| 거대 클래스 분석 | 3000줄+ 헤더는 forward declaration을 잡을 수 있음 | Grep + Read |
| 부모 클래스 추적 | UE 매크로 상속(GENERATED_BODY) 파싱 한계 | Grep |
| 동명 함수 | callees에서 동명 함수 결과가 섞일 수 있음 | 고유한 함수명에만 사용 |

---

## 트러블슈팅

### tree-sitter / better-sqlite3 빌드 에러 (Windows)

`npm install` 시 네이티브 모듈 빌드가 실패할 수 있습니다.

**해결:**
1. Visual Studio Build Tools 설치 (C++ 빌드 도구 워크로드 선택):
   https://visualstudio.microsoft.com/visual-cpp-build-tools/

2. setup.bat 다시 실행 (node-gyp 설치가 포함되어 있음)

### MCP 서버가 Claude Code에서 안 보임

1. `mcp.json`이 UE 프로젝트 루트에 있는지 확인
2. `args` 경로가 **절대 경로**인지 확인
3. Claude Code 재시작
4. `/mcp` 명령으로 서버 상태 확인

### 인덱싱 시 "Invalid argument" 파싱 에러 (모든 파일)

```
[WARN] Failed to parse G:\...\MyActor.h: Error: Invalid argument
```

모든 파일에서 이 에러가 발생하면 **Node.js 버전 문제**입니다.

**원인:** Node.js v25 등 Current 버전은 tree-sitter 네이티브 바이너리가 없어 파싱 불가

**해결:**
1. Node.js **LTS 버전 (v20 또는 v22)** 설치: https://nodejs.org → **LTS** 탭 선택
2. 기존 `node_modules` 삭제 후 `setup.bat` 다시 실행

```powershell
# Node.js 버전 확인
node --version
# v20.x.x 또는 v22.x.x 여야 합니다

# node_modules 삭제 후 재설치
cd C:\Tools\ue-codegraph-mcp
rmdir /s /q node_modules
.\setup.bat
```

### 인덱싱 후 결과가 없음

1. `ue-graph status`로 파일/심볼 수 확인
2. 경로에 한글·공백이 있으면 큰따옴표로 감싸기
3. `.h` / `.cpp` 파일이 있는 Source 폴더를 지정했는지 확인
