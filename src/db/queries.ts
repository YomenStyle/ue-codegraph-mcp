import Database from 'better-sqlite3';
import { getDb } from './database.js';

export interface PreparedQueries {
  // Codebases
  insertCodebase: Database.Statement;
  getCodebaseByPath: Database.Statement;
  getCodebaseById: Database.Statement;
  listCodebases: Database.Statement;
  updateCodebaseIndexedAt: Database.Statement;

  // Files
  insertFile: Database.Statement;
  getFileByPath: Database.Statement;
  getFileById: Database.Statement;
  updateFileHash: Database.Statement;
  deleteFileData: Database.Statement;
  getFilesByCodebase: Database.Statement;
  countFilesByCodebase: Database.Statement;

  // Symbols
  insertSymbol: Database.Statement;
  getSymbolById: Database.Statement;
  getSymbolsByFile: Database.Statement;
  getSymbolsByName: Database.Statement;
  getSymbolsByKind: Database.Statement;
  getSymbolsByParent: Database.Statement;
  countSymbolsByCodebase: Database.Statement;

  // Parameters
  insertParameter: Database.Statement;
  getParametersBySymbol: Database.Statement;

  // Inheritance
  insertInheritance: Database.Statement;
  getChildClasses: Database.Statement;
  getParentClasses: Database.Statement;
  resolveInheritanceByName: Database.Statement;

  // UE Macros
  insertMacro: Database.Statement;
  getMacrosByFile: Database.Statement;
  getMacrosBySymbol: Database.Statement;
  getMacrosByType: Database.Statement;
  linkMacroToSymbol: Database.Statement;
  countMacrosByCodebase: Database.Statement;

  // Macro Specifiers
  insertSpecifier: Database.Statement;
  getSpecifiersByMacro: Database.Statement;

  // Calls
  insertCall: Database.Statement;
  getCallers: Database.Statement;
  getCallees: Database.Statement;
  resolveCallsByName: Database.Statement;

  // Includes
  insertInclude: Database.Statement;
  getIncludesByFile: Database.Statement;
  getIncludedBy: Database.Statement;
  resolveIncludeByPath: Database.Statement;

  // References
  insertReference: Database.Statement;
  getReferencesBySymbol: Database.Statement;
  getReferencesByFile: Database.Statement;
  resolveReferencesByName: Database.Statement;

  // FTS search
  searchSymbolsFts: Database.Statement;
}

let _queries: PreparedQueries | null = null;

export function getQueries(): PreparedQueries {
  if (!_queries) {
    const db = getDb();
    _queries = prepareAll(db);
  }
  return _queries;
}

export function resetQueries(): void {
  _queries = null;
}

function prepareAll(db: Database.Database): PreparedQueries {
  return {
    // Codebases
    insertCodebase: db.prepare(
      `INSERT INTO codebases (name, root_path, type) VALUES (@name, @rootPath, @type)`
    ),
    getCodebaseByPath: db.prepare(
      `SELECT * FROM codebases WHERE root_path = @rootPath`
    ),
    getCodebaseById: db.prepare(
      `SELECT * FROM codebases WHERE id = @id`
    ),
    listCodebases: db.prepare(
      `SELECT * FROM codebases ORDER BY created_at DESC`
    ),
    updateCodebaseIndexedAt: db.prepare(
      `UPDATE codebases SET last_indexed_at = datetime('now') WHERE id = @id`
    ),

    // Files
    insertFile: db.prepare(
      `INSERT OR REPLACE INTO files (codebase_id, relative_path, absolute_path, content_hash, mtime, file_size)
       VALUES (@codebaseId, @relativePath, @absolutePath, @contentHash, @mtime, @fileSize)`
    ),
    getFileByPath: db.prepare(
      `SELECT * FROM files WHERE absolute_path = @absolutePath`
    ),
    getFileById: db.prepare(
      `SELECT * FROM files WHERE id = @id`
    ),
    updateFileHash: db.prepare(
      `UPDATE files SET content_hash = @contentHash, mtime = @mtime, file_size = @fileSize,
       indexed_at = datetime('now') WHERE id = @id`
    ),
    deleteFileData: db.prepare(
      `DELETE FROM files WHERE id = @id`
    ),
    getFilesByCodebase: db.prepare(
      `SELECT * FROM files WHERE codebase_id = @codebaseId`
    ),
    countFilesByCodebase: db.prepare(
      `SELECT COUNT(*) as count FROM files WHERE codebase_id = @codebaseId`
    ),

    // Symbols
    insertSymbol: db.prepare(
      `INSERT INTO symbols (file_id, name, qualified_name, kind, access, is_static, is_virtual,
       is_const, is_inline, return_type, line_start, line_end, column_start, parent_symbol_id, signature, raw_text)
       VALUES (@fileId, @name, @qualifiedName, @kind, @access, @isStatic, @isVirtual,
       @isConst, @isInline, @returnType, @lineStart, @lineEnd, @columnStart, @parentSymbolId, @signature, @rawText)`
    ),
    getSymbolById: db.prepare(
      `SELECT s.*, f.absolute_path as file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.id = @id`
    ),
    getSymbolsByFile: db.prepare(
      `SELECT * FROM symbols WHERE file_id = @fileId ORDER BY line_start`
    ),
    getSymbolsByName: db.prepare(
      `SELECT s.*, f.absolute_path as file_path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = @name`
    ),
    getSymbolsByKind: db.prepare(
      `SELECT s.*, f.absolute_path as file_path FROM symbols s
       JOIN files f ON s.file_id = f.id
       JOIN files f2 ON f2.codebase_id = @codebaseId AND f2.id = s.file_id
       WHERE s.kind = @kind LIMIT @limit`
    ),
    getSymbolsByParent: db.prepare(
      `SELECT * FROM symbols WHERE parent_symbol_id = @parentId ORDER BY line_start`
    ),
    countSymbolsByCodebase: db.prepare(
      `SELECT COUNT(*) as count FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.codebase_id = @codebaseId`
    ),

    // Parameters
    insertParameter: db.prepare(
      `INSERT INTO parameters (symbol_id, name, type, default_value, position)
       VALUES (@symbolId, @name, @type, @defaultValue, @position)`
    ),
    getParametersBySymbol: db.prepare(
      `SELECT * FROM parameters WHERE symbol_id = @symbolId ORDER BY position`
    ),

    // Inheritance
    insertInheritance: db.prepare(
      `INSERT INTO inheritance (child_symbol_id, parent_name, parent_symbol_id, access, is_virtual, child_name)
       VALUES (@childSymbolId, @parentName, @parentSymbolId, @access, @isVirtual, @childName)`
    ),
    getChildClasses: db.prepare(
      `SELECT i.*, s.name as child_class_name, f.absolute_path as file_path
       FROM inheritance i
       JOIN symbols s ON i.child_symbol_id = s.id
       JOIN files f ON s.file_id = f.id
       WHERE i.parent_name = @parentName OR i.parent_symbol_id = @parentSymbolId`
    ),
    getParentClasses: db.prepare(
      `SELECT i.*, s.name as parent_class_name, f.absolute_path as file_path
       FROM inheritance i
       LEFT JOIN symbols s ON i.parent_symbol_id = s.id
       LEFT JOIN files f ON s.file_id = f.id
       WHERE i.child_symbol_id = @childSymbolId`
    ),
    resolveInheritanceByName: db.prepare(
      `UPDATE inheritance SET parent_symbol_id = @parentSymbolId
       WHERE parent_name = @parentName AND parent_symbol_id IS NULL`
    ),

    // UE Macros
    insertMacro: db.prepare(
      `INSERT INTO ue_macros (file_id, symbol_id, macro_type, line_number, raw_text)
       VALUES (@fileId, @symbolId, @macroType, @lineNumber, @rawText)`
    ),
    getMacrosByFile: db.prepare(
      `SELECT * FROM ue_macros WHERE file_id = @fileId ORDER BY line_number`
    ),
    getMacrosBySymbol: db.prepare(
      `SELECT m.*, GROUP_CONCAT(ms.key || COALESCE('=' || ms.value, ''), ', ') as specifiers_str
       FROM ue_macros m
       LEFT JOIN ue_macro_specifiers ms ON ms.macro_id = m.id
       WHERE m.symbol_id = @symbolId
       GROUP BY m.id`
    ),
    getMacrosByType: db.prepare(
      `SELECT m.*, f.absolute_path as file_path, s.name as symbol_name
       FROM ue_macros m
       JOIN files f ON m.file_id = f.id
       LEFT JOIN symbols s ON m.symbol_id = s.id
       WHERE m.macro_type = @macroType AND f.codebase_id = @codebaseId
       LIMIT @limit`
    ),
    linkMacroToSymbol: db.prepare(
      `UPDATE ue_macros SET symbol_id = @symbolId WHERE id = @macroId`
    ),
    countMacrosByCodebase: db.prepare(
      `SELECT COUNT(*) as count FROM ue_macros m JOIN files f ON m.file_id = f.id WHERE f.codebase_id = @codebaseId`
    ),

    // Macro Specifiers
    insertSpecifier: db.prepare(
      `INSERT INTO ue_macro_specifiers (macro_id, key, value, is_meta)
       VALUES (@macroId, @key, @value, @isMeta)`
    ),
    getSpecifiersByMacro: db.prepare(
      `SELECT * FROM ue_macro_specifiers WHERE macro_id = @macroId`
    ),

    // Calls
    insertCall: db.prepare(
      `INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, file_id, line_number, caller_name)
       VALUES (@callerSymbolId, @calleeName, @calleeSymbolId, @fileId, @lineNumber, @callerName)`
    ),
    getCallers: db.prepare(
      `SELECT c.*, s.name as caller_name_resolved, f.absolute_path as file_path
       FROM calls c
       LEFT JOIN symbols s ON c.caller_symbol_id = s.id
       JOIN files f ON c.file_id = f.id
       WHERE c.callee_name = @calleeName OR c.callee_symbol_id = @calleeSymbolId
       LIMIT @limit`
    ),
    getCallees: db.prepare(
      `SELECT c.*, s.name as callee_name_resolved, f.absolute_path as file_path
       FROM calls c
       LEFT JOIN symbols s ON c.callee_symbol_id = s.id
       JOIN files f ON c.file_id = f.id
       WHERE c.caller_symbol_id = @callerSymbolId
       LIMIT @limit`
    ),
    resolveCallsByName: db.prepare(
      `UPDATE calls SET callee_symbol_id = @calleeSymbolId
       WHERE callee_name = @calleeName AND callee_symbol_id IS NULL`
    ),

    // Includes
    insertInclude: db.prepare(
      `INSERT INTO includes (file_id, included_path, resolved_file_id, is_system, line_number)
       VALUES (@fileId, @includedPath, @resolvedFileId, @isSystem, @lineNumber)`
    ),
    getIncludesByFile: db.prepare(
      `SELECT i.*, f.absolute_path as resolved_path
       FROM includes i
       LEFT JOIN files f ON i.resolved_file_id = f.id
       WHERE i.file_id = @fileId`
    ),
    getIncludedBy: db.prepare(
      `SELECT i.*, f.absolute_path as source_path
       FROM includes i
       JOIN files f ON i.file_id = f.id
       WHERE i.resolved_file_id = @fileId`
    ),
    resolveIncludeByPath: db.prepare(
      `UPDATE includes SET resolved_file_id = @resolvedFileId
       WHERE included_path = @includedPath AND resolved_file_id IS NULL`
    ),

    // References
    insertReference: db.prepare(
      `INSERT INTO references_table (symbol_id, file_id, symbol_name, line_number, column_number, context)
       VALUES (@symbolId, @fileId, @symbolName, @lineNumber, @columnNumber, @context)`
    ),
    getReferencesBySymbol: db.prepare(
      `SELECT r.*, f.absolute_path as file_path
       FROM references_table r
       JOIN files f ON r.file_id = f.id
       WHERE r.symbol_name = @symbolName OR r.symbol_id = @symbolId
       LIMIT @limit`
    ),
    getReferencesByFile: db.prepare(
      `SELECT r.*, s.name as resolved_name
       FROM references_table r
       LEFT JOIN symbols s ON r.symbol_id = s.id
       WHERE r.file_id = @fileId`
    ),
    resolveReferencesByName: db.prepare(
      `UPDATE references_table SET symbol_id = @symbolId
       WHERE symbol_name = @symbolName AND symbol_id IS NULL`
    ),

    // FTS search
    searchSymbolsFts: db.prepare(
      `SELECT s.*, f.absolute_path as file_path, rank
       FROM symbols_fts fts
       JOIN symbols s ON s.id = fts.rowid
       JOIN files f ON s.file_id = f.id
       WHERE symbols_fts MATCH @query
       ORDER BY rank
       LIMIT @limit`
    ),
  };
}
