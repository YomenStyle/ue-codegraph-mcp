import { parseFile } from './parser.js';
import { extractSymbols, ExtractedSymbol } from './symbol-extractor.js';
import { extractMacros } from './macro-extractor.js';
import {
  extractCalls, extractIncludes, extractReferences,
  ExtractedCall, ExtractedInclude, ExtractedReference,
} from './relationship-builder.js';
import { computeFileHash } from './incremental.js';
import type { UEMacro } from '../ue/macro-types.js';

/** Everything the DB layer needs for one file. Plain data only, so it can cross a worker boundary. */
export interface ParsedFile {
  absolutePath: string;
  contentHash: string;
  /** false when tree-sitter / IO failed: the file record is still stored so it is not retried every run */
  parsed: boolean;
  symbols: ExtractedSymbol[];
  macros: UEMacro[];
  calls: ExtractedCall[];
  includes: ExtractedInclude[];
  references: ExtractedReference[];
}

/** CPU-heavy, DB-free part of indexing a file. Runs on the main thread or inside a worker. */
export function parseTask(absolutePath: string): ParsedFile {
  const empty: ParsedFile = {
    absolutePath, contentHash: '', parsed: false,
    symbols: [], macros: [], calls: [], includes: [], references: [],
  };

  try {
    empty.contentHash = computeFileHash(absolutePath);
  } catch {
    return empty; // vanished between discovery and parsing
  }

  const parseResult = parseFile(absolutePath);
  if (!parseResult) return empty;

  const { tree, source, originalSource } = parseResult;
  try {
    const symbols = extractSymbols(tree, source);
    const knownNames = new Set(symbols.map(s => s.name));

    return {
      absolutePath,
      contentHash: empty.contentHash,
      parsed: true,
      symbols,
      macros: extractMacros(originalSource),
      calls: extractCalls(tree, source, symbols),
      includes: extractIncludes(originalSource),
      references: extractReferences(tree, source, knownNames),
    };
  } finally {
    (tree as any).delete?.(); // release native tree memory
  }
}
