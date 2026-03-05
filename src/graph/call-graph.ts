import { getDb } from '../db/database.js';

export interface CallerInfo {
  callerName: string;
  callerSymbolId: number | null;
  filePath: string;
  lineNumber: number;
}

export interface CalleeInfo {
  calleeName: string;
  calleeSymbolId: number | null;
  filePath: string;
  lineNumber: number;
}

export interface CallChainStep {
  depth: number;
  callerName: string;
  calleeName: string;
  filePath: string;
  lineNumber: number;
}

export function findCallers(functionName: string, maxResults = 50): CallerInfo[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      COALESCE(cs.name, c.caller_name) as callerName,
      c.caller_symbol_id as callerSymbolId,
      f.absolute_path as filePath,
      c.line_number as lineNumber
    FROM calls c
    JOIN files f ON c.file_id = f.id
    LEFT JOIN symbols cs ON c.caller_symbol_id = cs.id
    WHERE c.callee_name = @name
       OR c.callee_symbol_id IN (SELECT id FROM symbols WHERE name = @name)
    ORDER BY f.absolute_path, c.line_number
    LIMIT @limit
  `).all({ name: functionName, limit: maxResults }) as CallerInfo[];
}

export function findCallees(functionName: string, maxResults = 50): CalleeInfo[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      c.callee_name as calleeName,
      c.callee_symbol_id as calleeSymbolId,
      f.absolute_path as filePath,
      c.line_number as lineNumber
    FROM calls c
    JOIN files f ON c.file_id = f.id
    WHERE c.caller_name = @name
       OR c.caller_symbol_id IN (SELECT id FROM symbols WHERE name = @name)
    ORDER BY c.line_number
    LIMIT @limit
  `).all({ name: functionName, limit: maxResults }) as CalleeInfo[];
}

export function findCallChain(
  fromFunction: string,
  toFunction: string,
  maxDepth = 10,
): CallChainStep[] {
  const db = getDb();

  // Use recursive CTE to find shortest call chain from -> to
  const result = db.prepare(`
    WITH RECURSIVE call_chain(depth, caller_name, callee_name, file_path, line_number, visited) AS (
      -- Base case: direct calls from the start function
      SELECT
        1,
        COALESCE(cs.name, c.caller_name),
        c.callee_name,
        f.absolute_path,
        c.line_number,
        '|' || COALESCE(cs.name, c.caller_name) || '|' || c.callee_name || '|'
      FROM calls c
      JOIN files f ON c.file_id = f.id
      LEFT JOIN symbols cs ON c.caller_symbol_id = cs.id
      WHERE COALESCE(cs.name, c.caller_name) = @fromFunc

      UNION ALL

      -- Recursive case: follow the chain
      SELECT
        cc.depth + 1,
        cc.callee_name,
        c.callee_name,
        f.absolute_path,
        c.line_number,
        cc.visited || c.callee_name || '|'
      FROM call_chain cc
      JOIN calls c ON (c.caller_name = cc.callee_name OR
        c.caller_symbol_id IN (SELECT id FROM symbols WHERE name = cc.callee_name))
      JOIN files f ON c.file_id = f.id
      WHERE cc.depth < @maxDepth
        AND cc.visited NOT LIKE '%|' || c.callee_name || '|%'
        AND cc.callee_name != @toFunc
    )
    SELECT depth, caller_name as callerName, callee_name as calleeName,
           file_path as filePath, line_number as lineNumber
    FROM call_chain
    WHERE callee_name = @toFunc
    ORDER BY depth
    LIMIT 1
  `).all({
    fromFunc: fromFunction,
    toFunc: toFunction,
    maxDepth,
  }) as CallChainStep[];

  if (result.length === 0) return [];

  // Reconstruct the full chain by tracing back
  const targetDepth = result[0].depth;
  const fullChain = db.prepare(`
    WITH RECURSIVE call_chain(depth, caller_name, callee_name, file_path, line_number, path, visited) AS (
      SELECT
        1,
        COALESCE(cs.name, c.caller_name),
        c.callee_name,
        f.absolute_path,
        c.line_number,
        COALESCE(cs.name, c.caller_name) || ' -> ' || c.callee_name,
        '|' || COALESCE(cs.name, c.caller_name) || '|' || c.callee_name || '|'
      FROM calls c
      JOIN files f ON c.file_id = f.id
      LEFT JOIN symbols cs ON c.caller_symbol_id = cs.id
      WHERE COALESCE(cs.name, c.caller_name) = @fromFunc

      UNION ALL

      SELECT
        cc.depth + 1,
        cc.callee_name,
        c.callee_name,
        f.absolute_path,
        c.line_number,
        cc.path || ' -> ' || c.callee_name,
        cc.visited || c.callee_name || '|'
      FROM call_chain cc
      JOIN calls c ON (c.caller_name = cc.callee_name OR
        c.caller_symbol_id IN (SELECT id FROM symbols WHERE name = cc.callee_name))
      JOIN files f ON c.file_id = f.id
      WHERE cc.depth < @maxDepth
        AND cc.visited NOT LIKE '%|' || c.callee_name || '|%'
    )
    SELECT depth, caller_name as callerName, callee_name as calleeName,
           file_path as filePath, line_number as lineNumber
    FROM call_chain
    WHERE callee_name = @toFunc
    ORDER BY depth
    LIMIT 20
  `).all({
    fromFunc: fromFunction,
    toFunc: toFunction,
    maxDepth,
  }) as CallChainStep[];

  return fullChain;
}
