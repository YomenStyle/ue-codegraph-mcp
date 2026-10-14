import crypto from 'crypto';
import fs from 'fs';
import { getQueries } from '../db/queries.js';
import { DiscoveredFile } from './file-discovery.js';

export interface ChangeResult {
  newFiles: DiscoveredFile[];
  changedFiles: DiscoveredFile[];
  unchangedFiles: DiscoveredFile[];
  deletedFileIds: number[];
}

export function detectChanges(codebaseId: number, files: DiscoveredFile[]): ChangeResult {
  const queries = getQueries();
  const existingFiles = queries.getFilesByCodebase.all({ codebaseId }) as Array<{
    id: number;
    absolute_path: string;
    content_hash: string | null;
    mtime: number | null;
    file_size: number | null;
  }>;

  const existingMap = new Map<string, { id: number; hash: string | null; mtime: number | null; size: number | null }>();
  for (const ef of existingFiles) {
    existingMap.set(ef.absolute_path, { id: ef.id, hash: ef.content_hash, mtime: ef.mtime, size: ef.file_size });
  }

  const newFiles: DiscoveredFile[] = [];
  const changedFiles: DiscoveredFile[] = [];
  const unchangedFiles: DiscoveredFile[] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    seenPaths.add(file.absolutePath);
    const existing = existingMap.get(file.absolutePath);

    if (!existing) {
      newFiles.push(file);
    } else if (existing.size !== null && existing.size !== file.size) {
      changedFiles.push(file); // size differs: no need to hash
    } else if (existing.mtime === null || existing.mtime !== file.mtime) {
      // mtime moved (edit, git checkout, touch): the content hash decides
      let hash: string | null = null;
      try { hash = computeFileHash(file.absolutePath); } catch { /* unreadable: treat as changed */ }
      if (hash === null || hash !== existing.hash) {
        changedFiles.push(file);
      } else {
        unchangedFiles.push(file);
      }
    } else {
      unchangedFiles.push(file);
    }
  }

  // Find deleted files
  const deletedFileIds: number[] = [];
  for (const [path, info] of existingMap) {
    if (!seenPaths.has(path)) {
      deletedFileIds.push(info.id);
    }
  }

  return { newFiles, changedFiles, unchangedFiles, deletedFileIds };
}

export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}
