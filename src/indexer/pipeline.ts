import { getDb } from '../db/database.js';
import { getQueries } from '../db/queries.js';
import { getConfig } from '../config.js';
import { discoverFiles, DiscoveredFile } from './file-discovery.js';
import { parseFile } from './parser.js';
import { extractSymbols, ExtractedSymbol } from './symbol-extractor.js';
import { extractMacros } from './macro-extractor.js';
import { extractCalls, extractIncludes, extractReferences } from './relationship-builder.js';
import { detectChanges, computeFileHash } from './incremental.js';
import { resolveIncludes } from './include-resolver.js';
import { ProgressTracker } from '../utils/progress.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';

export interface IndexResult {
  codebaseId: number;
  totalFiles: number;
  newFiles: number;
  changedFiles: number;
  unchangedFiles: number;
  deletedFiles: number;
  totalSymbols: number;
  totalMacros: number;
  totalCalls: number;
  totalIncludes: number;
  elapsedMs: number;
}

export async function indexCodebase(rootPath: string, name: string, type: 'engine' | 'project', headersOnly = false): Promise<IndexResult> {
  const startTime = Date.now();
  const db = getDb();
  const queries = getQueries();
  const config = getConfig();

  // Register or get codebase
  let codebase = queries.getCodebaseByPath.get({ rootPath }) as { id: number } | undefined;
  if (!codebase) {
    queries.insertCodebase.run({ name, rootPath, type });
    codebase = queries.getCodebaseByPath.get({ rootPath }) as { id: number };
  }
  const codebaseId = codebase.id;

  // Discover files
  if (headersOnly) logger.info('Headers-only mode: skipping .cpp/.cc/.cxx files');
  const discoveredFiles = discoverFiles(rootPath, headersOnly);

  // Detect changes (incremental)
  const changes = detectChanges(codebaseId, discoveredFiles);
  const filesToIndex = [...changes.newFiles, ...changes.changedFiles];

  logger.info(`Files: ${changes.newFiles.length} new, ${changes.changedFiles.length} changed, ${changes.unchangedFiles.length} unchanged, ${changes.deletedFileIds.length} deleted`);

  // Delete removed files
  if (changes.deletedFileIds.length > 0) {
    const deleteStmt = db.prepare(`DELETE FROM files WHERE id = ?`);
    const deleteBatch = db.transaction((ids: number[]) => {
      for (const id of ids) deleteStmt.run(id);
    });
    deleteBatch(changes.deletedFileIds);
  }

  let totalSymbols = 0;
  let totalMacros = 0;
  let totalCalls = 0;
  let totalIncludes = 0;

  // Process files in batches
  const batchSize = config.batchSize;
  const progress = new ProgressTracker('Indexing', filesToIndex.length);

  for (let i = 0; i < filesToIndex.length; i += batchSize) {
    const batch = filesToIndex.slice(i, i + batchSize);

    const batchResult = db.transaction(() => {
      let bSymbols = 0;
      let bMacros = 0;
      let bCalls = 0;
      let bIncludes = 0;

      for (const file of batch) {
        const result = indexSingleFile(codebaseId, file, queries);
        bSymbols += result.symbols;
        bMacros += result.macros;
        bCalls += result.calls;
        bIncludes += result.includes;
        progress.increment();
      }

      return { bSymbols, bMacros, bCalls, bIncludes };
    })();

    totalSymbols += batchResult.bSymbols;
    totalMacros += batchResult.bMacros;
    totalCalls += batchResult.bCalls;
    totalIncludes += batchResult.bIncludes;
  }

  progress.finish();

  // Resolution pass
  logger.info('Running resolution pass...');
  runResolutionPass(codebaseId);

  // Resolve includes
  resolveIncludes(codebaseId);

  // Update codebase timestamp
  queries.updateCodebaseIndexedAt.run({ id: codebaseId });

  const elapsedMs = Date.now() - startTime;
  logger.info(`Indexing complete in ${(elapsedMs / 1000).toFixed(1)}s`);

  return {
    codebaseId,
    totalFiles: discoveredFiles.length,
    newFiles: changes.newFiles.length,
    changedFiles: changes.changedFiles.length,
    unchangedFiles: changes.unchangedFiles.length,
    deletedFiles: changes.deletedFileIds.length,
    totalSymbols,
    totalMacros,
    totalCalls,
    totalIncludes,
    elapsedMs,
  };
}

interface SingleFileResult {
  symbols: number;
  macros: number;
  calls: number;
  includes: number;
}

function indexSingleFile(
  codebaseId: number,
  file: DiscoveredFile,
  queries: ReturnType<typeof getQueries>,
): SingleFileResult {
  const result: SingleFileResult = { symbols: 0, macros: 0, calls: 0, includes: 0 };

  // Compute hash
  const contentHash = computeFileHash(file.absolutePath);

  // Check if file already exists (for re-indexing)
  const existingFile = queries.getFileByPath.get({ absolutePath: file.absolutePath }) as { id: number } | undefined;
  if (existingFile) {
    // Delete old data (CASCADE will clean up symbols, macros, etc.)
    queries.deleteFileData.run({ id: existingFile.id });
  }

  // Insert/update file record
  queries.insertFile.run({
    codebaseId,
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    contentHash,
    mtime: file.mtime,
    fileSize: file.size,
  });

  const fileRecord = queries.getFileByPath.get({ absolutePath: file.absolutePath }) as { id: number };
  const fileId = fileRecord.id;

  // Parse with tree-sitter
  const parseResult = parseFile(file.absolutePath);
  if (!parseResult) return result;

  const { tree, source, originalSource } = parseResult;

  try {
    // Extract symbols from preprocessed source (AST)
    const symbols = extractSymbols(tree, source);
    const symbolIdMap = new Map<string, number>(); // qualifiedName -> id
    result.symbols = insertSymbols(fileId, symbols, null, symbolIdMap, queries);

    // Extract UE macros from original source (regex-based)
    const macros = extractMacros(originalSource);
    result.macros = insertMacros(fileId, macros, symbolIdMap, symbols, queries);

    // Extract calls
    const calls = extractCalls(tree, source, symbols);
    result.calls = insertCalls(fileId, calls, symbolIdMap, queries);

    // Extract includes from original source
    const includes = extractIncludes(originalSource);
    result.includes = insertIncludes(fileId, includes, queries);

    // Extract references for known symbols in this file
    const knownNames = new Set(symbols.map(s => s.name));
    const refs = extractReferences(tree, source, knownNames);
    insertReferences(fileId, refs, queries);

  } finally {
    // Release tree-sitter tree to free memory
    (tree as any).delete?.();
  }

  return result;
}

function insertSymbols(
  fileId: number,
  symbols: ExtractedSymbol[],
  parentSymbolId: number | null,
  symbolIdMap: Map<string, number>,
  queries: ReturnType<typeof getQueries>,
): number {
  let count = 0;

  for (const sym of symbols) {
    const info = queries.insertSymbol.run({
      fileId,
      name: sym.name,
      qualifiedName: sym.qualifiedName,
      kind: sym.kind,
      access: sym.access,
      isStatic: sym.isStatic ? 1 : 0,
      isVirtual: sym.isVirtual ? 1 : 0,
      isConst: sym.isConst ? 1 : 0,
      isInline: sym.isInline ? 1 : 0,
      returnType: sym.returnType,
      lineStart: sym.lineStart,
      lineEnd: sym.lineEnd,
      columnStart: sym.columnStart,
      parentSymbolId,
      signature: sym.signature,
      rawText: sym.rawText,
    });
    const symbolId = Number(info.lastInsertRowid);
    count++;

    if (sym.qualifiedName) {
      symbolIdMap.set(sym.qualifiedName, symbolId);
    }
    symbolIdMap.set(sym.name, symbolId);

    // Insert parameters
    for (const param of sym.parameters) {
      queries.insertParameter.run({
        symbolId,
        name: param.name,
        type: param.type,
        defaultValue: param.defaultValue,
        position: param.position,
      });
    }

    // Insert inheritance
    for (const base of sym.baseClasses) {
      queries.insertInheritance.run({
        childSymbolId: symbolId,
        parentName: base.name,
        parentSymbolId: null, // resolved later
        access: base.access,
        isVirtual: base.isVirtual ? 1 : 0,
        childName: sym.name,
      });
    }

    // Recursively insert children
    if (sym.children.length > 0) {
      count += insertSymbols(fileId, sym.children, symbolId, symbolIdMap, queries);
    }
  }

  return count;
}

function insertMacros(
  fileId: number,
  macros: import('../ue/macro-types.js').UEMacro[],
  symbolIdMap: Map<string, number>,
  symbols: ExtractedSymbol[],
  queries: ReturnType<typeof getQueries>,
): number {
  let count = 0;

  // Build sorted symbol list for proximity matching
  // Note: symbol line numbers come from preprocessed source but should still be close
  // to original positions since we preserve line count during preprocessing
  const allSymbols = flattenSymbols(symbols);
  const sortedSymbols = [...allSymbols].sort((a, b) => a.lineStart - b.lineStart);

  for (const macro of macros) {
    // Find associated symbol: the closest symbol at or after the macro line
    let associatedSymbolId: number | null = null;
    const macroLine = macro.lineNumber;

    // For class-level macros (UCLASS, USTRUCT, UENUM), look for the class itself
    const isClassMacro = ['UCLASS', 'USTRUCT', 'UENUM', 'UINTERFACE'].includes(macro.macroType);
    // For member macros (UPROPERTY, UFUNCTION), look for the next member
    const isMemberMacro = ['UPROPERTY', 'UFUNCTION'].includes(macro.macroType);

    // Find next symbol after macro line (within reasonable distance)
    for (const sym of sortedSymbols) {
      if (sym.lineStart < macroLine) continue;
      if (sym.lineStart > macroLine + 10) break; // too far

      // Filter by kind based on macro type
      if (isClassMacro && !['class', 'struct', 'enum'].includes(sym.kind)) continue;
      if (isMemberMacro && !['method', 'function', 'field', 'constructor', 'destructor', 'variable'].includes(sym.kind)) continue;

      const key = sym.qualifiedName || sym.name;
      associatedSymbolId = symbolIdMap.get(key) || null;
      break;
    }

    const info = queries.insertMacro.run({
      fileId,
      symbolId: associatedSymbolId,
      macroType: macro.macroType,
      lineNumber: macro.lineNumber,
      rawText: macro.rawText,
    });
    const macroId = Number(info.lastInsertRowid);
    count++;

    // Insert specifiers
    for (const spec of [...macro.specifiers, ...macro.metaSpecifiers]) {
      queries.insertSpecifier.run({
        macroId,
        key: spec.key,
        value: spec.value,
        isMeta: spec.isMeta ? 1 : 0,
      });
    }
  }

  return count;
}

function insertCalls(
  fileId: number,
  calls: import('./relationship-builder.js').ExtractedCall[],
  symbolIdMap: Map<string, number>,
  queries: ReturnType<typeof getQueries>,
): number {
  let count = 0;
  for (const call of calls) {
    const callerSymbolId = symbolIdMap.get(call.callerName) || null;
    const calleeSymbolId = symbolIdMap.get(call.calleeName) || null;

    queries.insertCall.run({
      callerSymbolId,
      calleeName: call.calleeName,
      calleeSymbolId,
      fileId,
      lineNumber: call.lineNumber,
      callerName: call.callerName,
    });
    count++;
  }
  return count;
}

function insertIncludes(
  fileId: number,
  includes: import('./relationship-builder.js').ExtractedInclude[],
  queries: ReturnType<typeof getQueries>,
): number {
  let count = 0;
  for (const inc of includes) {
    queries.insertInclude.run({
      fileId,
      includedPath: inc.path,
      resolvedFileId: null, // resolved in post-pass
      isSystem: inc.isSystem ? 1 : 0,
      lineNumber: inc.lineNumber,
    });
    count++;
  }
  return count;
}

function insertReferences(
  fileId: number,
  refs: import('./relationship-builder.js').ExtractedReference[],
  queries: ReturnType<typeof getQueries>,
): void {
  for (const ref of refs) {
    queries.insertReference.run({
      symbolId: null, // resolved in post-pass
      fileId,
      symbolName: ref.symbolName,
      lineNumber: ref.lineNumber,
      columnNumber: ref.columnNumber,
      context: ref.context,
    });
  }
}

function flattenSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  const result: ExtractedSymbol[] = [];
  for (const s of symbols) {
    result.push(s);
    if (s.children.length > 0) {
      result.push(...flattenSymbols(s.children));
    }
  }
  return result;
}

/**
 * Resolution pass: link names to symbol IDs across files
 */
function runResolutionPass(codebaseId: number): void {
  const db = getDb();

  // Resolve inheritance parent names to symbol IDs
  const unresolvedInheritance = db.prepare(
    `SELECT DISTINCT i.parent_name
     FROM inheritance i
     JOIN symbols s ON i.child_symbol_id = s.id
     JOIN files f ON s.file_id = f.id
     WHERE f.codebase_id = ? AND i.parent_symbol_id IS NULL`
  ).all(codebaseId) as Array<{ parent_name: string }>;

  const findSymbolByName = db.prepare(
    `SELECT s.id FROM symbols s JOIN files f ON s.file_id = f.id
     WHERE s.name = ? AND f.codebase_id = ? AND s.kind IN ('class', 'struct', 'interface')
     LIMIT 1`
  );

  const updateInheritance = db.prepare(
    `UPDATE inheritance SET parent_symbol_id = ?
     WHERE parent_name = ? AND parent_symbol_id IS NULL`
  );

  const resolveInhBatch = db.transaction(() => {
    for (const { parent_name } of unresolvedInheritance) {
      const sym = findSymbolByName.get(parent_name, codebaseId) as { id: number } | undefined;
      if (sym) {
        updateInheritance.run(sym.id, parent_name);
      }
    }
  });
  resolveInhBatch();

  // Resolve call targets
  const unresolvedCalls = db.prepare(
    `SELECT DISTINCT c.callee_name
     FROM calls c
     JOIN files f ON c.file_id = f.id
     WHERE f.codebase_id = ? AND c.callee_symbol_id IS NULL`
  ).all(codebaseId) as Array<{ callee_name: string }>;

  const findFuncByName = db.prepare(
    `SELECT s.id FROM symbols s JOIN files f ON s.file_id = f.id
     WHERE s.name = ? AND f.codebase_id = ?
     AND s.kind IN ('function', 'method', 'constructor', 'destructor')
     LIMIT 1`
  );

  const updateCall = db.prepare(
    `UPDATE calls SET callee_symbol_id = ?
     WHERE callee_name = ? AND callee_symbol_id IS NULL`
  );

  const resolveCallBatch = db.transaction(() => {
    for (const { callee_name } of unresolvedCalls) {
      const sym = findFuncByName.get(callee_name, codebaseId) as { id: number } | undefined;
      if (sym) {
        updateCall.run(sym.id, callee_name);
      }
    }
  });
  resolveCallBatch();

  // Resolve references
  const unresolvedRefs = db.prepare(
    `SELECT DISTINCT r.symbol_name
     FROM references_table r
     JOIN files f ON r.file_id = f.id
     WHERE f.codebase_id = ? AND r.symbol_id IS NULL`
  ).all(codebaseId) as Array<{ symbol_name: string }>;

  const updateRef = db.prepare(
    `UPDATE references_table SET symbol_id = ?
     WHERE symbol_name = ? AND symbol_id IS NULL`
  );

  const findAnySymbol = db.prepare(
    `SELECT s.id FROM symbols s JOIN files f ON s.file_id = f.id
     WHERE s.name = ? AND f.codebase_id = ?
     LIMIT 1`
  );

  const resolveRefBatch = db.transaction(() => {
    for (const { symbol_name } of unresolvedRefs) {
      const sym = findAnySymbol.get(symbol_name, codebaseId) as { id: number } | undefined;
      if (sym) {
        updateRef.run(sym.id, symbol_name);
      }
    }
  });
  resolveRefBatch();

  logger.info('Resolution pass completed');
}

/**
 * Reindex a single file by path
 */
export async function reindexSingleFile(absolutePath: string): Promise<{ success: boolean; message: string }> {
  const db = getDb();
  const queries = getQueries();

  // Find the file's codebase
  const fileRecord = queries.getFileByPath.get({ absolutePath }) as { id: number; codebase_id: number } | undefined;

  if (!fileRecord) {
    // Try to find which codebase this file belongs to
    const codebases = queries.listCodebases.all() as Array<{ id: number; root_path: string }>;
    let codebaseId: number | null = null;
    for (const cb of codebases) {
      if (absolutePath.startsWith(cb.root_path)) {
        codebaseId = cb.id;
        break;
      }
    }
    if (!codebaseId) {
      return { success: false, message: 'File does not belong to any indexed codebase' };
    }

    // New file
    const stat = fs.statSync(absolutePath);
    const file: DiscoveredFile = {
      absolutePath,
      relativePath: absolutePath.substring(absolutePath.indexOf(absolutePath) + 1),
      mtime: stat.mtimeMs,
      size: stat.size,
    };

    db.transaction(() => {
      indexSingleFile(codebaseId!, file, queries);
    })();

    return { success: true, message: 'File indexed for the first time' };
  }

  // Re-index existing file
  const stat = fs.statSync(absolutePath);
  const codebase = queries.getCodebaseById.get({ id: fileRecord.codebase_id }) as { root_path: string };

  const file: DiscoveredFile = {
    absolutePath,
    relativePath: absolutePath.replace(codebase.root_path + '/', ''),
    mtime: stat.mtimeMs,
    size: stat.size,
  };

  db.transaction(() => {
    indexSingleFile(fileRecord.codebase_id, file, queries);
  })();

  return { success: true, message: 'File re-indexed successfully' };
}
