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

export function discoverFiles(rootPath: string, headersOnly = false): DiscoveredFile[] {
  const config = getConfig();
  const results: DiscoveredFile[] = [];
  const extensions = headersOnly ? HEADER_EXTENSIONS : new Set(config.fileExtensions);

  function shouldExclude(filePath: string): boolean {
    const rel = path.relative(rootPath, filePath);
    for (const pattern of config.excludePatterns) {
      const cleaned = pattern.replace(/\*\*\//g, '');
      if (rel.includes(cleaned.replace(/\*\*/g, ''))) {
        return true;
      }
    }
    return false;
  }

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
