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

/**
 * Narrows a codebase below its root. Relative paths (and therefore #include resolution) stay
 * relative to the root, so one codebase can span e.g. `Source/` and `Plugins/` of a project.
 *  - includeDirs: sub-folders of the root to index (empty / undefined = the whole root)
 *  - excludePatterns: extra patterns on top of the global defaults, same syntax (`**` + `/Foo/`)
 */
export interface CodebaseScope {
  includeDirs?: string[];
  excludePatterns?: string[];
}

const normDir = (d: string) => d.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');

/** Parse the JSON columns of a `codebases` row (null / malformed = no restriction). */
export function scopeFromRow(row: { include_dirs?: string | null; exclude_patterns?: string | null }): CodebaseScope {
  const parse = (v?: string | null): string[] | undefined => {
    if (!v) return undefined;
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;
    } catch { return undefined; }
  };
  return { includeDirs: parse(row.include_dirs), excludePatterns: parse(row.exclude_patterns) };
}

/** Serialise for the DB; empty lists are stored as NULL. */
export function scopeToColumns(scope?: CodebaseScope): { includeDirs: string | null; excludePatterns: string | null } {
  const ser = (a?: string[]) => {
    const clean = (a ?? []).map(s => s.trim()).filter(Boolean);
    return clean.length ? JSON.stringify(clean) : null;
  };
  return { includeDirs: ser(scope?.includeDirs?.map(normDir)), excludePatterns: ser(scope?.excludePatterns) };
}

function isInIncludeDirs(rootPath: string, filePath: string, scope?: CodebaseScope): boolean {
  const dirs = scope?.includeDirs;
  if (!dirs || dirs.length === 0) return true;
  const rel = path.relative(rootPath, filePath).split(path.sep).join('/');
  return dirs.some(d => {
    const n = normDir(d);
    return n === '' || rel === n || rel.startsWith(n + '/');
  });
}

function isExcluded(rootPath: string, filePath: string, scope?: CodebaseScope): boolean {
  const rel = path.relative(rootPath, filePath);
  for (const pattern of [...getConfig().excludePatterns, ...(scope?.excludePatterns ?? [])]) {
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
export function isIndexablePath(rootPath: string, filePath: string, headersOnly = false, scope?: CodebaseScope): boolean {
  const rel = path.relative(rootPath, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.split(path.sep).some(seg => seg.startsWith('.') && seg.length > 1)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const extensions = headersOnly ? HEADER_EXTENSIONS : new Set(getConfig().fileExtensions);
  if (!extensions.has(ext)) return false;
  if (!isInIncludeDirs(rootPath, filePath, scope)) return false;
  return !isExcluded(rootPath, filePath, scope);
}

export function discoverFiles(rootPath: string, headersOnly = false, scope?: CodebaseScope): DiscoveredFile[] {
  const config = getConfig();
  const results: DiscoveredFile[] = [];
  const extensions = headersOnly ? HEADER_EXTENSIONS : new Set(config.fileExtensions);
  const shouldExclude = (filePath: string) => isExcluded(rootPath, filePath, scope);
  const seen = new Set<string>();

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

        if (seen.has(fullPath)) continue; // overlapping include dirs
        seen.add(fullPath);

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

  const starts: string[] = [];
  for (const d of scope?.includeDirs ?? []) {
    const abs = path.resolve(rootPath, normDir(d));
    const rel = path.relative(rootPath, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      logger.warn(`include dir "${d}" is outside ${rootPath}, ignored`);
    } else if (!fs.existsSync(abs)) {
      logger.warn(`include dir "${d}" does not exist under ${rootPath}, ignored`);
    } else {
      starts.push(abs);
    }
  }
  const restricted = (scope?.includeDirs?.length ?? 0) > 0;
  logger.info(`Discovering files in ${rootPath}${restricted ? ` (only: ${scope!.includeDirs!.join(', ')})` : ''}...`);
  if (restricted) {
    if (starts.length === 0) logger.warn('No valid include dirs - nothing to index');
    for (const s of starts) walk(s);
  } else {
    walk(rootPath);
  }
  logger.info(`Discovered ${results.length} files`);
  return results;
}
