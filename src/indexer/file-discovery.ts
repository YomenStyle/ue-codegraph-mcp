import fs from 'fs';
import path from 'path';
import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  mtime: number;
  size: number;
}

const HEADER_EXTENSIONS = new Set(['.h', '.hpp', '.inl']);

function isExcluded(rootPath: string, filePath: string): boolean {
  const rel = path.relative(rootPath, filePath);
  for (const pattern of getConfig().excludePatterns) {
    const cleaned = pattern.replace(/\*\*\//g, '');
    const needle = cleaned.replace(/\*\*/g, '');
    // patterns are written with '/', relative paths use the OS separator
    if (rel.includes(needle) || rel.includes(needle.replace(/\//g, path.sep))) {
      return true;
    }
  }
  return false;
}

/** True when `filePath` (inside `rootPath`) is a source file the indexer would pick up. */
export function isIndexablePath(rootPath: string, filePath: string, headersOnly = false): boolean {
  const rel = path.relative(rootPath, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.split(path.sep).some(seg => seg.startsWith('.') && seg.length > 1)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const extensions = headersOnly ? HEADER_EXTENSIONS : new Set(getConfig().fileExtensions);
  if (!extensions.has(ext)) return false;
  return !isExcluded(rootPath, filePath);
}

export function discoverFiles(rootPath: string, headersOnly = false): DiscoveredFile[] {
  const config = getConfig();
  const results: DiscoveredFile[] = [];
  const extensions = headersOnly ? HEADER_EXTENSIONS : new Set(config.fileExtensions);
  const shouldExclude = (filePath: string) => isExcluded(rootPath, filePath);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // skip inaccessible directories
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (shouldExclude(fullPath)) continue;
        if (entry.name.startsWith('.')) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.has(ext)) continue;
        if (shouldExclude(fullPath)) continue;

        try {
          const stat = fs.statSync(fullPath);
          results.push({
            absolutePath: fullPath,
            relativePath: path.relative(rootPath, fullPath),
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
          // skip files we can't stat
        }
      }
    }
  }

  logger.info(`Discovering files in ${rootPath}...`);
  walk(rootPath);
  logger.info(`Discovered ${results.length} files`);
  return results;
}
