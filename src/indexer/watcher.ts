import fs from 'fs';
import path from 'path';
import { getConfig } from '../config.js';
import { getQueries } from '../db/queries.js';
import { isIndexablePath, scopeFromRow, CodebaseScope } from './file-discovery.js';
import { indexCodebase, reindexPaths } from './pipeline.js';
import { logger } from '../utils/logger.js';

interface WatchedCodebase {
  id: number;
  name: string;
  root_path: string;
  type: 'engine' | 'project';
  headers_only: number;
  include_dirs?: string | null;
  exclude_patterns?: string | null;
}

/**
 * Watches one codebase root and re-indexes just the files that change.
 * Events are debounced and coalesced, so "save + formatter + git" becomes a single re-index.
 */
export class CodebaseWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    readonly root: string,
    private readonly headersOnly: boolean,
    private readonly scope?: CodebaseScope,
    private readonly onIndexed?: (summary: string) => void,
  ) {}

  start(): void {
    if (this.watcher) return;
    try {
      // `recursive` is native on Windows/macOS and on Linux since Node 20.
      this.watcher = fs.watch(this.root, { recursive: true, persistent: true }, (_event, filename) => {
        if (!filename) return;
        const abs = path.join(this.root, filename.toString());
        if (!isIndexablePath(this.root, abs, this.headersOnly, this.scope)) return;
        this.pending.add(abs);
        this.schedule();
      });
      this.watcher.on('error', err => {
        logger.warn(`Watcher error on ${this.root}: ${err}`);
        this.stop();
      });
      logger.info(`Watching ${this.root}`);
    } catch (err) {
      logger.warn(`Cannot watch ${this.root}: ${err}`);
      this.watcher = null;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  get active(): boolean {
    return this.watcher !== null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), getConfig().watchDebounceMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing) { this.schedule(); return; }
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0) return;

    this.flushing = true;
    try {
      const r = await reindexPaths(paths);
      if (r.indexed + r.deleted > 0) {
        const msg = `[watch] ${path.basename(this.root)}: ${r.message}`;
        logger.info(msg);
        this.onIndexed?.(msg);
      }
    } catch (err) {
      logger.warn(`Watch re-index failed: ${err}`);
    } finally {
      this.flushing = false;
    }
  }
}

const watchers = new Map<string, CodebaseWatcher>();

/** Start watching a codebase root (idempotent). */
export function watchCodebase(root: string, headersOnly: boolean, scope?: CodebaseScope): CodebaseWatcher {
  const key = path.resolve(root);
  let w = watchers.get(key);
  if (!w || !w.active) {
    w?.stop();
    w = new CodebaseWatcher(key, headersOnly, scope);
    watchers.set(key, w);
    w.start();
  }
  return w;
}

export function stopAllWatchers(): void {
  for (const w of watchers.values()) w.stop();
  watchers.clear();
}

export function listWatched(): string[] {
  return [...watchers.entries()].filter(([, w]) => w.active).map(([k]) => k);
}

/**
 * Called when the MCP server starts: catch up on edits made while it was off
 * (cheap incremental scan, runs in the background), then keep watching.
 */
export function startWatchingAll(opts: { catchUp?: boolean } = {}): void {
  if (!getConfig().watch) {
    logger.info('File watching disabled (UE_CODEGRAPH_WATCH=0)');
    return;
  }
  const codebases = getQueries().listCodebases.all() as WatchedCodebase[];
  for (const cb of codebases) {
    if (!fs.existsSync(cb.root_path)) {
      logger.warn(`Skipping watch for missing path ${cb.root_path}`);
      continue;
    }
    // Watch first so edits during the catch-up scan are not lost; they queue behind it on the index lock.
    watchCodebase(cb.root_path, !!cb.headers_only, scopeFromRow(cb));
    if (opts.catchUp !== false) {
      indexCodebase(cb.root_path, cb.name, cb.type, !!cb.headers_only, scopeFromRow(cb))
        .then(r => logger.info(`Catch-up ${cb.name}: ${r.newFiles} new, ${r.changedFiles} changed, ${r.deletedFiles} deleted`))
        .catch(err => logger.warn(`Catch-up of ${cb.name} failed: ${err}`));
    }
  }
}
