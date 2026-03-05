import path from 'path';
import { getDb } from '../db/database.js';
import { logger } from '../utils/logger.js';

/**
 * Resolve #include paths to file IDs in the database.
 * Runs as a post-indexing pass to link include records to resolved files.
 */
export function resolveIncludes(codebaseId: number): number {
  const db = getDb();
  let resolved = 0;

  // Get all files for this codebase
  const files = db.prepare(
    `SELECT id, relative_path, absolute_path FROM files WHERE codebase_id = ?`
  ).all(codebaseId) as Array<{ id: number; relative_path: string; absolute_path: string }>;

  // Build lookup maps
  const byRelative = new Map<string, number>();
  const byFilename = new Map<string, number[]>();

  for (const f of files) {
    byRelative.set(f.relative_path, f.id);
    // Also add normalized path (forward slashes)
    byRelative.set(f.relative_path.replace(/\\/g, '/'), f.id);

    const filename = path.basename(f.relative_path);
    if (!byFilename.has(filename)) {
      byFilename.set(filename, []);
    }
    byFilename.get(filename)!.push(f.id);
  }

  // Get unresolved includes
  const unresolved = db.prepare(
    `SELECT i.id, i.included_path, i.file_id
     FROM includes i
     JOIN files f ON i.file_id = f.id
     WHERE f.codebase_id = ? AND i.resolved_file_id IS NULL AND i.is_system = 0`
  ).all(codebaseId) as Array<{ id: number; included_path: string; file_id: number }>;

  const updateStmt = db.prepare(
    `UPDATE includes SET resolved_file_id = ? WHERE id = ?`
  );

  const updateMany = db.transaction((items: Array<{ includeId: number; fileId: number }>) => {
    for (const item of items) {
      updateStmt.run(item.fileId, item.includeId);
    }
  });

  const toUpdate: Array<{ includeId: number; fileId: number }> = [];

  for (const inc of unresolved) {
    const includePath = inc.included_path.replace(/\\/g, '/');

    // Try exact relative path match
    let resolvedId = byRelative.get(includePath);

    // Try matching by filename with path suffix
    if (!resolvedId) {
      const filename = path.basename(includePath);
      const candidates = byFilename.get(filename);
      if (candidates) {
        if (candidates.length === 1) {
          resolvedId = candidates[0];
        } else {
          // Match by path suffix
          for (const cid of candidates) {
            const file = files.find(f => f.id === cid);
            if (file && file.relative_path.replace(/\\/g, '/').endsWith(includePath)) {
              resolvedId = cid;
              break;
            }
          }
        }
      }
    }

    if (resolvedId) {
      toUpdate.push({ includeId: inc.id, fileId: resolvedId });
      resolved++;
    }
  }

  if (toUpdate.length > 0) {
    updateMany(toUpdate);
  }

  logger.info(`Resolved ${resolved}/${unresolved.length} includes`);
  return resolved;
}
