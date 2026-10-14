import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { parseTask, ParsedFile } from './parse-task.js';

type Job = {
  id: number;
  paths: string[];
  resolve: (r: ParsedFile[]) => void;
  reject: (e: unknown) => void;
};

/**
 * Small worker_threads pool for tree-sitter parsing. Falls back to inline parsing when
 * workers are disabled, the batch is small, or a worker cannot load the native addon.
 */
class ParsePool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private inflight = new Map<Worker, Job>();
  private nextId = 1;
  private broken = false;

  private spawn(): Worker {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'parse-worker.js');
    const w = new Worker(file);
    w.on('message', (msg: { id: number; results: Array<ParsedFile & { error?: string }> }) => {
      const job = this.inflight.get(w);
      this.inflight.delete(w);
      this.idle.push(w);
      if (job) {
        // A per-file error becomes an unparsed record; the file is simply stored without symbols.
        job.resolve(msg.results.map(r => (r.error ? emptyResult(r.absolutePath, r.error) : r)));
      }
      this.pump();
    });
    w.on('error', err => this.onWorkerFailure(w, err));
    w.on('exit', code => { if (code !== 0) this.onWorkerFailure(w, new Error(`worker exited with ${code}`)); });
    return w;
  }

  private onWorkerFailure(w: Worker, err: unknown): void {
    const job = this.inflight.get(w);
    this.inflight.delete(w);
    this.workers = this.workers.filter(x => x !== w);
    this.idle = this.idle.filter(x => x !== w);
    if (!this.broken) {
      this.broken = true;
      logger.warn(`Parse worker failed, falling back to inline parsing: ${err}`);
    }
    // Re-run the lost job inline and drain whatever is still queued.
    if (job) this.runInline(job);
    for (const queued of this.queue.splice(0)) this.runInline(queued);
    void this.shutdown();
  }

  private runInline(job: Job): void {
    try { job.resolve(job.paths.map(parseTask)); } catch (e) { job.reject(e); }
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.inflight.set(w, job);
      w.postMessage({ id: job.id, paths: job.paths });
    }
  }

  private ensureWorkers(count: number): void {
    while (this.workers.length < count) {
      const w = this.spawn();
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Parse `paths`, preserving order. Splits the work across workers when it is worth it. */
  async parseAll(paths: string[]): Promise<ParsedFile[]> {
    const { workers, parallelThreshold } = getConfig();
    if (paths.length === 0) return [];
    if (this.broken || workers <= 1 || paths.length < parallelThreshold) {
      return paths.map(parseTask);
    }

    try {
      this.ensureWorkers(workers);
    } catch (err) {
      this.broken = true;
      logger.warn(`Cannot start parse workers (${err}); parsing inline`);
      return paths.map(parseTask);
    }

    const chunkSize = Math.max(4, Math.ceil(paths.length / (workers * 3)));
    const jobs: Promise<ParsedFile[]>[] = [];
    for (let i = 0; i < paths.length; i += chunkSize) {
      const slice = paths.slice(i, i + chunkSize);
      jobs.push(new Promise<ParsedFile[]>((resolve, reject) => {
        this.queue.push({ id: this.nextId++, paths: slice, resolve, reject });
      }));
    }
    this.pump();
    return (await Promise.all(jobs)).flat();
  }

  async shutdown(): Promise<void> {
    const ws = this.workers.splice(0);
    this.idle = [];
    this.inflight.clear();
    for (const w of ws) { w.removeAllListeners(); w.on('error', () => {}); } // terminate() exits non-zero
    await Promise.allSettled(ws.map(w => w.terminate()));
  }
}

function emptyResult(absolutePath: string, error: string): ParsedFile {
  logger.warn(`Failed to parse ${absolutePath}: ${error}`);
  return parseTaskFallback(absolutePath);
}

function parseTaskFallback(absolutePath: string): ParsedFile {
  return { absolutePath, contentHash: '', parsed: false, symbols: [], macros: [], calls: [], includes: [], references: [] };
}

let pool: ParsePool | null = null;

export function getParsePool(): ParsePool {
  if (!pool) pool = new ParsePool();
  return pool;
}

export async function shutdownParsePool(): Promise<void> {
  if (pool) { await pool.shutdown(); pool = null; }
}
