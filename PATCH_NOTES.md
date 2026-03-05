# Patch Notes

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
