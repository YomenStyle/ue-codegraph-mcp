import { getDb } from '../db/database.js';

export interface ReferenceInfo {
  symbolName: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  context: string;
  kind: string | null;
}

export interface SymbolSearchResult {
  name: string;
  qualifiedName: string | null;
  kind: string;
  filePath: string;
  lineNumber: number;
  signature: string | null;
  rank: number;
}

export function findReferences(symbolName: string, maxResults = 50): ReferenceInfo[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      r.symbol_name as symbolName,
      f.absolute_path as filePath,
      r.line_number as lineNumber,
      r.column_number as columnNumber,
      r.context,
      s.kind
    FROM references_table r
    JOIN files f ON r.file_id = f.id
    LEFT JOIN symbols s ON r.symbol_id = s.id
    WHERE r.symbol_name = @name
       OR r.symbol_id IN (SELECT id FROM symbols WHERE name = @name)
    ORDER BY f.absolute_path, r.line_number
    LIMIT @limit
  `).all({ name: symbolName, limit: maxResults }) as ReferenceInfo[];
}

export function searchSymbols(query: string, maxResults = 50): SymbolSearchResult[] {
  const db = getDb();

  // Try FTS first for exact/prefix matches
  const ftsQuery = sanitizeFtsQuery(query);
  let results: SymbolSearchResult[] = [];

  try {
    results = db.prepare(`
      SELECT s.name, s.qualified_name as qualifiedName, s.kind,
             f.absolute_path as filePath, s.line_start as lineNumber,
             s.signature, rank
      FROM symbols_fts fts
      JOIN symbols s ON s.id = fts.rowid
      JOIN files f ON s.file_id = f.id
      WHERE symbols_fts MATCH @query
      ORDER BY rank
      LIMIT @limit
    `).all({ query: ftsQuery, limit: maxResults }) as SymbolSearchResult[];
  } catch {
    // FTS query error - fall through to LIKE
  }

  // Fallback to LIKE for substring matching if FTS returned nothing
  if (results.length === 0) {
    results = db.prepare(`
      SELECT s.name, s.qualified_name as qualifiedName, s.kind,
             f.absolute_path as filePath, s.line_start as lineNumber,
             s.signature, 0 as rank
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name LIKE @pattern OR s.qualified_name LIKE @pattern
      ORDER BY s.name
      LIMIT @limit
    `).all({ pattern: `%${query}%`, limit: maxResults }) as SymbolSearchResult[];
  }

  return results;
}

export function searchCode(pattern: string, codebaseId: number, maxResults = 50): Array<{
  filePath: string;
  lineNumber: number;
  lineContent: string;
}> {
  const db = getDb();
  // Search in raw_text of symbols and context of references
  const results: Array<{ filePath: string; lineNumber: number; lineContent: string }> = [];

  // Search in symbol raw text
  const symbolResults = db.prepare(`
    SELECT f.absolute_path as filePath, s.line_start as lineNumber,
           SUBSTR(s.raw_text, 1, 200) as lineContent
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE f.codebase_id = @codebaseId
      AND s.raw_text LIKE @pattern
    LIMIT @limit
  `).all({
    codebaseId,
    pattern: `%${pattern}%`,
    limit: maxResults,
  }) as Array<{ filePath: string; lineNumber: number; lineContent: string }>;

  results.push(...symbolResults);

  // Also search references context
  if (results.length < maxResults) {
    const refResults = db.prepare(`
      SELECT f.absolute_path as filePath, r.line_number as lineNumber,
             r.context as lineContent
      FROM references_table r
      JOIN files f ON r.file_id = f.id
      WHERE f.codebase_id = @codebaseId
        AND r.context LIKE @pattern
      LIMIT @limit
    `).all({
      codebaseId,
      pattern: `%${pattern}%`,
      limit: maxResults - results.length,
    }) as Array<{ filePath: string; lineNumber: number; lineContent: string }>;

    results.push(...refResults);
  }

  return results;
}

function sanitizeFtsQuery(query: string): string {
  // Remove FTS special characters
  const cleaned = query.replace(/[*"():^~{}[\]]/g, '').trim();
  if (!cleaned) return '""';

  // Split into tokens and add prefix matching with wildcard
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
  // Use prefix matching: each token gets a wildcard for partial matching
  return tokens.map(t => `${t}*`).join(' ');
}
