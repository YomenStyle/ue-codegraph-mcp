import fs from 'fs';
import path from 'path';
import { getDb, prep } from '../db/database.js';
import { getQueries } from '../db/queries.js';
import { getConfig } from '../config.js';
import { discoverFiles, isIndexablePath, scopeFromRow, scopeToColumns, DiscoveredFile, CodebaseScope } from './file-discovery.js';
import { ExtractedSymbol } from './symbol-extractor.js';
import { detectChanges, computeFileHash } from './incremental.js';
import { resolveLinks, emptyScope, ResolveScope } from './resolver.js';
import { getParsePool } from './worker-pool.js';
import type { ParsedFile } from './parse-task.js';
import { ProgressTracker } from '../utils/progress.js';
import { logger } from '../utils/logger.js';

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
  /** 'full' = resolved every row (first index / big change), 'incremental' = only affected rows */
  mode: 'full' | 'incremental';
  relinkedFiles: number | 'all';
}

type Queries = ReturnType<typeof getQueries>;

interface CodebaseRow {
  id: number;
  name: string;
  root_path: string;
  type: 'engine' | 'project';
  headers_only: number;
  include_dirs?: string | null;
  exclude_patterns?: string | null;
}

// ---------------------------------------------------------------------------
// Serialisation: CLI, MCP tools and the file watcher may all want to write at once.
// ---------------------------------------------------------------------------

let indexLock: Promise<unknown> = Promise.resolve();

export function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  indexLock = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Full / incremental directory index
// ---------------------------------------------------------------------------

export function indexCodebase(
  rootPath: string,
  name: string,
  type: 'engine' | 'project',
  headersOnly = false,
  scope?: CodebaseScope,
): Promise<IndexResult> {
  return withIndexLock(() => runIndexCodebase(path.resolve(rootPath), name, type, headersOnly, scope));
}

async function runIndexCodebase(
  rootPath: string,
  name: string,
  type: 'engine' | 'project',
  headersOnly: boolean,
  scope?: CodebaseScope,
): Promise<IndexResult> {
  const startTime = Date.now();
  const db = getDb();
  const queries = getQueries();

  let codebase = queries.getCodebaseByPath.get({ rootPath }) as CodebaseRow | undefined;
  if (!codebase) {
    queries.insertCodebase.run({ name, rootPath, type, headersOnly: headersOnly ? 1 : 0, ...scopeToColumns(scope) });
    codebase = queries.getCodebaseByPath.get({ rootPath }) as CodebaseRow;
  } else {
    if (!!codebase.headers_only !== headersOnly) {
      prep('UPDATE codebases SET headers_only = ? WHERE id = ?').run(headersOnly ? 1 : 0, codebase.id);
    }
    // `scope` omitted = keep what is stored; given (even empty) = replace it. Files that fall out of scope are
    // reported as deleted by the change detection below.
    if (scope) queries.updateCodebaseScope.run({ id: codebase.id, ...scopeToColumns(scope) });
  }
  const codebaseId = codebase.id;
  const effectiveScope: CodebaseScope = scope ?? scopeFromRow(codebase);

  if (headersOnly) logger.info('Headers-only mode: skipping .cpp/.cc/.cxx files');
  const discoveredFiles = discoverFiles(rootPath, headersOnly, effectiveScope);

  const changes = detectChanges(codebaseId, discoveredFiles);
  logger.info(`Files: ${changes.newFiles.length} new, ${changes.changedFiles.length} changed, ${changes.unchangedFiles.length} unchanged, ${changes.deletedFileIds.length} deleted`);

  const applied = await applyChanges(
    codebaseId,
    [...changes.newFiles, ...changes.changedFiles],
    changes.deletedFileIds,
    discoveredFiles.length,
  );

  queries.updateCodebaseIndexedAt.run({ id: codebaseId });
  const elapsedMs = Date.now() - startTime;
  logger.info(`Indexing complete in ${(elapsedMs / 1000).toFixed(1)}s (${applied.mode})`);

  return {
    codebaseId,
    totalFiles: discoveredFiles.length,
    newFiles: changes.newFiles.length,
    changedFiles: changes.changedFiles.length,
    unchangedFiles: changes.unchangedFiles.length,
    deletedFiles: changes.deletedFileIds.length,
    totalSymbols: applied.symbols,
    totalMacros: applied.macros,
    totalCalls: applied.calls,
    totalIncludes: applied.includes,
    elapsedMs,
    mode: applied.mode,
    relinkedFiles: applied.relinkedFiles,
  };
}

interface ApplyResult {
  symbols: number;
  macros: number;
  calls: number;
  includes: number;
  mode: 'full' | 'incremental';
  relinkedFiles: number | 'all';
}

/**
 * Core of every indexing path: drop `deletedIds`, (re)parse `toIndex`, then link only what changed.
 * Parsing runs on worker threads and overlaps with the DB writes of the previous batch.
 */
async function applyChanges(
  codebaseId: number,
  toIndex: DiscoveredFile[],
  deletedIds: number[],
  totalFiles?: number,
): Promise<ApplyResult> {
  const db = getDb();
  const queries = getQueries();
  const config = getConfig();
  const out: ApplyResult = { symbols: 0, macros: 0, calls: 0, includes: 0, mode: 'incremental', relinkedFiles: 0 };

  if (toIndex.length === 0 && deletedIds.length === 0) return out;

  // --- 1. Snapshot what is about to be replaced (needed to know which links can go stale) ---
  const scope = emptyScope();
  const existingCount = (queries.countFilesByCodebase.get({ codebaseId }) as { count: number }).count;
  const total = totalFiles ?? existingCount;

  const namesOf = prep('SELECT DISTINCT name FROM symbols WHERE file_id = ?');
  const includesOf = prep('SELECT included_path FROM includes WHERE file_id = ?');
  const includersOf = prep('SELECT DISTINCT file_id FROM includes WHERE resolved_file_id = ?');
  const pathOf = prep('SELECT relative_path FROM files WHERE id = ?');

  const oldIncludes = new Map<number, Set<string>>();
  for (const f of toIndex) {
    const row = queries.getFileByPath.get({ codebaseId, absolutePath: f.absolutePath }) as { id: number } | undefined;
    if (!row) continue;
    for (const r of namesOf.all(row.id) as Array<{ name: string }>) scope.names.add(r.name);
    oldIncludes.set(row.id, new Set((includesOf.all(row.id) as Array<{ included_path: string }>).map(r => r.included_path)));
  }
  for (const id of deletedIds) {
    for (const r of namesOf.all(id) as Array<{ name: string }>) scope.names.add(r.name);
    const rel = (pathOf.get(id) as { relative_path: string } | undefined)?.relative_path;
    if (rel) scope.basenames.add(path.basename(rel));
    for (const r of includersOf.all(id) as Array<{ file_id: number }>) scope.fileIds.add(r.file_id);
  }

  // --- 2. Remove deleted files ---
  if (deletedIds.length > 0) {
    const del = prep('DELETE FROM files WHERE id = ?');
    db.transaction(() => { for (const id of deletedIds) del.run(id); })();
  }

  // --- 3. Parse (workers) + store (main thread), one batch ahead ---
  const batchSize = config.batchSize;
  const batches: DiscoveredFile[][] = [];
  for (let i = 0; i < toIndex.length; i += batchSize) batches.push(toIndex.slice(i, i + batchSize));

  const pool = getParsePool();
  const parseBatch = (b: DiscoveredFile[]) => pool.parseAll(b.map(f => f.absolutePath));
  const progress = new ProgressTracker('Indexing', toIndex.length);
  let pending = batches.length > 0 ? parseBatch(batches[0]) : null;

  for (let i = 0; i < batches.length; i++) {
    const parsed = await pending!;
    pending = i + 1 < batches.length ? parseBatch(batches[i + 1]) : null;

    db.transaction(() => {
      batches[i].forEach((file, k) => {
        const r = storeParsed(codebaseId, file, parsed[k], queries, scope, oldIncludes);
        out.symbols += r.symbols;
        out.macros += r.macros;
        out.calls += r.calls;
        out.includes += r.includes;
        progress.increment();
      });
    })();
  }
  progress.finish();

  // --- 4. Link ---
  const changedShare = (toIndex.length + deletedIds.length) / Math.max(total, 1);
  const full = existingCount === 0 || changedShare > config.fullResolveRatio;
  out.mode = full ? 'full' : 'incremental';
  logger.info(`Running ${out.mode} resolution...`);
  out.relinkedFiles = resolveLinks(codebaseId, full ? null : scope).relinkedFiles;

  return out;
}

interface SingleFileResult {
  symbols: number;
  macros: number;
  calls: number;
  includes: number;
}

/** Remove everything derived from a file but keep the file row (and therefore its id, which others link to). */
function clearFileData(db: ReturnType<typeof getDb>, fileId: number): void {
  prep('DELETE FROM symbols WHERE file_id = ?').run(fileId);      // params, inheritance(child), nested symbols cascade
  prep('DELETE FROM ue_macros WHERE file_id = ?').run(fileId);    // specifiers cascade
  prep('DELETE FROM calls WHERE file_id = ?').run(fileId);
  prep('DELETE FROM includes WHERE file_id = ?').run(fileId);
  prep('DELETE FROM references_table WHERE file_id = ?').run(fileId);
}

function storeParsed(
  codebaseId: number,
  file: DiscoveredFile,
  parsed: ParsedFile,
  queries: Queries,
  scope: ResolveScope,
  oldIncludes: Map<number, Set<string>>,
): SingleFileResult {
  const db = getDb();
  const result: SingleFileResult = { symbols: 0, macros: 0, calls: 0, includes: 0 };

  let contentHash = parsed.contentHash;
  if (!contentHash) {
    try { contentHash = computeFileHash(file.absolutePath); } catch { contentHash = ''; }
  }

  const existing = queries.getFileByPath.get({ codebaseId, absolutePath: file.absolutePath }) as { id: number } | undefined;
  let fileId: number;
  if (existing) {
    fileId = existing.id;
    clearFileData(db, fileId);
    queries.updateFileHash.run({ id: fileId, contentHash, mtime: file.mtime, fileSize: file.size });
  } else {
    const info = queries.insertFile.run({
      codebaseId,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      contentHash,
      mtime: file.mtime,
      fileSize: file.size,
    });
    fileId = Number(info.lastInsertRowid);
    scope.basenames.add(path.basename(file.relativePath)); // others may have been waiting for this header
  }
  scope.fileIds.add(fileId);

  if (!parsed.parsed) return result;

  const symbolIdMap = new Map<string, number>(); // qualifiedName -> id
  result.symbols = insertSymbols(fileId, parsed.symbols, null, symbolIdMap, queries);
  result.macros = insertMacros(fileId, parsed.macros, symbolIdMap, parsed.symbols, queries);
  result.calls = insertCalls(fileId, parsed.calls, symbolIdMap, queries);
  result.includes = insertIncludes(fileId, parsed.includes, queries);
  insertReferences(fileId, parsed.references, queries);

  for (const s of flattenSymbols(parsed.symbols)) scope.names.add(s.name);

  const before = oldIncludes.get(fileId);
  const after = new Set(parsed.includes.map(i => i.path));
  if (!before || before.size !== after.size || [...after].some(p => !before.has(p))) {
    scope.includeChangedFileIds.add(fileId);
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
    // A class and its constructor share a name and the line above overwrites the class with the
    // constructor, so type symbols also get an unambiguous entry (used for UCLASS/USTRUCT/... macros).
    if (['class', 'struct', 'enum', 'interface', 'union'].includes(sym.kind)) {
      symbolIdMap.set(`type:${sym.name}`, symbolId);
      if (sym.qualifiedName) symbolIdMap.set(`type:${sym.qualifiedName}`, symbolId);
    }

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
      associatedSymbolId = (isClassMacro ? symbolIdMap.get(`type:${key}`) : undefined) || symbolIdMap.get(key) || null;
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


// ---------------------------------------------------------------------------
// Targeted re-index (watcher, reindex_file tool, CLI)
// ---------------------------------------------------------------------------

export interface ReindexSummary {
  success: boolean;
  message: string;
  indexed: number;
  deleted: number;
  skipped: number;
}

const isInside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Bring the index in sync for specific paths: re-parse the ones whose content changed,
 * drop the ones that no longer exist. Only affected links are re-resolved.
 * `force` re-parses even when the content hash is unchanged.
 */
export function reindexPaths(paths: string[], opts: { force?: boolean } = {}): Promise<ReindexSummary> {
  return withIndexLock(async () => {
    const queries = getQueries();
    const codebases = queries.listCodebases.all() as CodebaseRow[];
    const summary: ReindexSummary = { success: true, message: '', indexed: 0, deleted: 0, skipped: 0 };
    let outside = 0;

    const perCodebase = new Map<number, { toIndex: DiscoveredFile[]; deleted: number[] }>();

    for (const raw of new Set(paths.map(p => path.resolve(p)))) {
      // Codebases may overlap (e.g. one for Source/, one for the whole project): update every one that holds the file.
      const owners = codebases.filter(c => isInside(path.resolve(c.root_path), raw));
      if (owners.length === 0) { outside++; continue; }

      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(raw); } catch { /* gone */ }

      for (const cb of owners) {
        let bucket = perCodebase.get(cb.id);
        if (!bucket) perCodebase.set(cb.id, (bucket = { toIndex: [], deleted: [] }));

        const row = queries.getFileByPath.get({ codebaseId: cb.id, absolutePath: raw }) as { id: number; content_hash: string | null } | undefined;

        if (stat?.isFile() && isIndexablePath(cb.root_path, raw, !!cb.headers_only, scopeFromRow(cb))) {
          if (row && !opts.force) {
            let same = false;
            try { same = computeFileHash(raw) === row.content_hash; } catch { /* unreadable: re-parse */ }
            if (same) { summary.skipped++; continue; }
          }
          bucket.toIndex.push({
            absolutePath: raw,
            relativePath: path.relative(cb.root_path, raw),
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } else if (row) {
          bucket.deleted.push(row.id);
        } else {
          summary.skipped++;
        }
      }
    }

    for (const [codebaseId, { toIndex, deleted }] of perCodebase) {
      await applyChanges(codebaseId, toIndex, deleted);
      queries.updateCodebaseIndexedAt.run({ id: codebaseId });
      summary.indexed += toIndex.length;
      summary.deleted += deleted.length;
    }

    if (outside > 0 && summary.indexed + summary.deleted + summary.skipped === 0) {
      summary.success = false;
      summary.message = 'File does not belong to any indexed codebase';
    } else {
      summary.message = `Re-indexed ${summary.indexed}, removed ${summary.deleted}, unchanged/ignored ${summary.skipped}` +
        (outside ? `, outside any codebase ${outside}` : '');
    }
    return summary;
  });
}

/** Single-file convenience wrapper kept for the MCP tool and CLI. Always re-parses. */
export async function reindexSingleFile(absolutePath: string): Promise<{ success: boolean; message: string }> {
  const r = await reindexPaths([absolutePath], { force: true });
  return { success: r.success, message: r.message };
}
