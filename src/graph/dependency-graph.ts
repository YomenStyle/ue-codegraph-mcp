import { getDb } from '../db/database.js';

export interface DependencyInfo {
  filePath: string;
  includedPath: string;
  resolvedPath: string | null;
  isSystem: boolean;
  lineNumber: number;
}

export interface DependencyTree {
  filePath: string;
  includes: DependencyInfo[];
  includedBy: DependencyInfo[];
}

export function getFileDependencies(filePath: string, maxDepth = 3): DependencyTree {
  const db = getDb();

  // Find file
  const file = db.prepare(
    `SELECT id, absolute_path FROM files WHERE absolute_path = ?`
  ).get(filePath) as { id: number; absolute_path: string } | undefined;

  if (!file) {
    return { filePath, includes: [], includedBy: [] };
  }

  // What does this file include?
  const includes = db.prepare(`
    SELECT
      f.absolute_path as filePath,
      i.included_path as includedPath,
      rf.absolute_path as resolvedPath,
      i.is_system as isSystem,
      i.line_number as lineNumber
    FROM includes i
    JOIN files f ON i.file_id = f.id
    LEFT JOIN files rf ON i.resolved_file_id = rf.id
    WHERE i.file_id = ?
    ORDER BY i.line_number
  `).all(file.id) as DependencyInfo[];

  // What files include this file?
  const includedBy = db.prepare(`
    SELECT
      f.absolute_path as filePath,
      i.included_path as includedPath,
      rf.absolute_path as resolvedPath,
      i.is_system as isSystem,
      i.line_number as lineNumber
    FROM includes i
    JOIN files f ON i.file_id = f.id
    LEFT JOIN files rf ON i.resolved_file_id = rf.id
    WHERE i.resolved_file_id = ?
    ORDER BY f.absolute_path
  `).all(file.id) as DependencyInfo[];

  return { filePath: file.absolute_path, includes, includedBy };
}

export function getTransitiveDependencies(filePath: string, maxDepth = 5): string[] {
  const db = getDb();

  const file = db.prepare(
    `SELECT id FROM files WHERE absolute_path = ?`
  ).get(filePath) as { id: number } | undefined;

  if (!file) return [];

  const result = db.prepare(`
    WITH RECURSIVE dep_chain(file_id, depth, visited) AS (
      SELECT i.resolved_file_id, 1, '|' || ? || '|' || CAST(i.resolved_file_id AS TEXT) || '|'
      FROM includes i
      WHERE i.file_id = ? AND i.resolved_file_id IS NOT NULL

      UNION ALL

      SELECT i.resolved_file_id, dc.depth + 1,
             dc.visited || CAST(i.resolved_file_id AS TEXT) || '|'
      FROM dep_chain dc
      JOIN includes i ON i.file_id = dc.file_id
      WHERE i.resolved_file_id IS NOT NULL
        AND dc.depth < ?
        AND dc.visited NOT LIKE '%|' || CAST(i.resolved_file_id AS TEXT) || '|%'
    )
    SELECT DISTINCT f.absolute_path
    FROM dep_chain dc
    JOIN files f ON dc.file_id = f.id
    ORDER BY f.absolute_path
  `).all(file.id, file.id, maxDepth) as Array<{ absolute_path: string }>;

  return result.map(r => r.absolute_path);
}
