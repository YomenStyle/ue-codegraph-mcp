export const SCHEMA_DDL = `
-- Registered codebases (engine or project)
CREATE TABLE IF NOT EXISTS codebases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'project' CHECK(type IN ('engine', 'project')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_indexed_at TEXT
);

-- Indexed files
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codebase_id INTEGER NOT NULL REFERENCES codebases(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  content_hash TEXT,
  mtime REAL,
  file_size INTEGER,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(codebase_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_files_codebase ON files(codebase_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(absolute_path);

-- All symbols (classes, functions, fields, enums, etc.)
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qualified_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'class', 'struct', 'enum', 'enum_value', 'function', 'method',
    'constructor', 'destructor', 'field', 'variable', 'typedef',
    'namespace', 'template', 'macro_definition', 'union', 'interface'
  )),
  access TEXT CHECK(access IN ('public', 'protected', 'private')),
  is_static INTEGER DEFAULT 0,
  is_virtual INTEGER DEFAULT 0,
  is_const INTEGER DEFAULT 0,
  is_inline INTEGER DEFAULT 0,
  return_type TEXT,
  line_start INTEGER,
  line_end INTEGER,
  column_start INTEGER,
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  signature TEXT,
  raw_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);

-- Function parameters
CREATE TABLE IF NOT EXISTS parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  name TEXT,
  type TEXT NOT NULL,
  default_value TEXT,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_params_symbol ON parameters(symbol_id);

-- Inheritance relationships
CREATE TABLE IF NOT EXISTS inheritance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  parent_name TEXT NOT NULL,
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  access TEXT DEFAULT 'public',
  is_virtual INTEGER DEFAULT 0,
  child_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_inh_child ON inheritance(child_symbol_id);
CREATE INDEX IF NOT EXISTS idx_inh_parent ON inheritance(parent_symbol_id);
CREATE INDEX IF NOT EXISTS idx_inh_parent_name ON inheritance(parent_name);
CREATE INDEX IF NOT EXISTS idx_inh_child_name ON inheritance(child_name);

-- UE macros (UCLASS, UPROPERTY, UFUNCTION, etc.)
CREATE TABLE IF NOT EXISTS ue_macros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  macro_type TEXT NOT NULL CHECK(macro_type IN (
    'UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION',
    'UINTERFACE', 'UMETA', 'GENERATED_BODY', 'GENERATED_UCLASS_BODY',
    'DECLARE_DYNAMIC_MULTICAST_DELEGATE', 'DECLARE_DELEGATE',
    'DECLARE_EVENT', 'DECLARE_MULTICAST_DELEGATE',
    'DECLARE_DYNAMIC_DELEGATE', 'OTHER'
  )),
  line_number INTEGER,
  raw_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_macros_file ON ue_macros(file_id);
CREATE INDEX IF NOT EXISTS idx_macros_symbol ON ue_macros(symbol_id);
CREATE INDEX IF NOT EXISTS idx_macros_type ON ue_macros(macro_type);

-- UE macro specifiers
CREATE TABLE IF NOT EXISTS ue_macro_specifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  macro_id INTEGER NOT NULL REFERENCES ue_macros(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  is_meta INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_spec_macro ON ue_macro_specifiers(macro_id);
CREATE INDEX IF NOT EXISTS idx_spec_key ON ue_macro_specifiers(key);

-- Function call relationships
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name TEXT NOT NULL,
  callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line_number INTEGER,
  caller_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee_name ON calls(callee_name);
CREATE INDEX IF NOT EXISTS idx_calls_caller_name ON calls(caller_name);

-- Include dependencies
CREATE TABLE IF NOT EXISTS includes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  included_path TEXT NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  is_system INTEGER DEFAULT 0,
  line_number INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inc_file ON includes(file_id);
CREATE INDEX IF NOT EXISTS idx_inc_resolved ON includes(resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_inc_path ON includes(included_path);

-- Symbol cross-references
CREATE TABLE IF NOT EXISTS references_table (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_name TEXT NOT NULL,
  line_number INTEGER,
  column_number INTEGER,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON references_table(symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_file ON references_table(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_name ON references_table(symbol_name);

-- FTS5 full-text search on symbols
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  qualified_name,
  kind,
  signature,
  content=symbols,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, qualified_name, kind, signature)
  VALUES (new.id, new.name, new.qualified_name, new.kind, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, kind, signature)
  VALUES ('delete', old.id, old.name, old.qualified_name, old.kind, old.signature);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, kind, signature)
  VALUES ('delete', old.id, old.name, old.qualified_name, old.kind, old.signature);
  INSERT INTO symbols_fts(rowid, name, qualified_name, kind, signature)
  VALUES (new.id, new.name, new.qualified_name, new.kind, new.signature);
END;
`;
