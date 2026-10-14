# Patch Notes

## Unreleased
- Feature: 코드베이스 범위 지정 (`include_dirs` / `exclude`) - 한 코드베이스로 여러 폴더(예: `Source` + `Plugins`)를 묶어서 인덱싱
  - 경로는 항상 루트 기준 상대경로라서 Source <-> Plugins 사이의 include / 호출 / 상속 링크가 한 그래프에서 연결됨
  - CLI: `ue-graph index <root> <name> --include=Source,Plugins --exclude=**/Tests/**`
  - MCP: `init_codebase` 툴에 `include_dirs`, `exclude` 파라미터 추가 (생략하면 저장된 설정 유지, `[]`는 초기화)
  - 설정은 DB(`codebases.include_dirs`, `exclude_patterns`, 스키마 v3)에 저장되어 watcher / 재시작 후 catch-up에도 동일하게 적용
  - 범위를 좁히면 범위 밖이 된 파일은 인덱스에서 제거됨
- Fix: 경로가 겹치는 코드베이스(예: 프로젝트 전체 + `Source`만)에서 파일 조회가 다른 코드베이스의 행을 잡아 덮어쓰던 문제 수정
  - 파일 조회를 코드베이스 단위로 한정하고, `reindex_file` / watcher는 해당 파일을 가진 모든 코드베이스를 갱신
- Viewer: 화면 한글화 (표시 문구만 치환하는 레이어, 로직 변경 없음)
- Test: `test/scope.test.mjs` 추가

## v1.0.6 (2026-03-05)
- Feature: `--headers-only` 옵션 추가 (엔진 소스 인덱싱 용량 절감용)
  - CLI: `ue-graph index <path> [name] --headers-only`
  - MCP: `init_codebase` 툴에 `headers_only` 파라미터 추가
  - `.h` / `.hpp` / `.inl` 만 인덱싱, `.cpp` / `.cc` / `.cxx` 제외
  - 클래스 계층·메서드 시그니처·UE 매크로 분석은 정상 동작, 엔진 내부 호출 그래프는 미지원

## v1.0.5 (2026-03-05)
- Fix: `virtual` 키워드가 있는 포인터/참조 반환 메서드가 인덱싱에서 누락되는 버그 수정
  - 예: `virtual UObject* GetObject() override;`, `virtual AActor& GetActor() override;`
  - symbol-extractor: `extractDeclaration`에서 `pointer_declarator` / `reference_declarator` 내부의 `function_declarator`를 탐색하도록 수정

## v1.0.4 (2026-03-04)
- Fix: analyze_class가 전방 선언(forward declaration) 위치를 클래스 정의로 잘못 반환하는 문제 수정
  - symbol-extractor.js: body 없는 class_specifier(전방 선언)는 심볼 등록 제외

## v1.0.3 (2026-03-04)
- Feature: .ue-codegraph-ignore 파일 지원 추가

## v1.0.2 (2026-03-04)
- Fix: tree-sitter 32KB 버퍼 한계로 인한 "Invalid argument" 에러 수정

## v1.0.1 (2026-03-04)
- Fix: Windows에서 한글(UTF-8) 주석 파일 파싱 시 "Invalid argument" 에러 수정
