import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AddressInfo } from 'net';
import * as data from './data.js';
import { logger } from '../utils/logger.js';

export interface ViewerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// build/viewer -> <repo>/viewer
const PAGE = path.resolve(here, '..', '..', 'viewer', 'index.html');

const num = (v: string | null, d: number, min: number, max: number) => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d;
};
const oneOf = <T extends string>(v: string | null, allowed: readonly T[], d: T): T =>
  (allowed as readonly string[]).includes(v ?? '') ? (v as T) : d;

function route(url: URL): unknown {
  const q = url.searchParams;
  const cbRaw = q.get('cb');
  const cb = cbRaw ? Number(cbRaw) : null;

  switch (url.pathname) {
    case '/api/codebases':
      return data.listCodebases();
    case '/api/version':
      return data.version(cb);
    case '/api/overview':
      if (cb === null) throw new HttpError(400, 'cb required');
      return data.overview(cb);
    case '/api/search': {
      const kinds = q.get('kinds')?.split(',').filter(Boolean) ?? null;
      return data.search(q.get('q') ?? '', cb, kinds);
    }
    case '/api/search-files':
      return data.searchFiles(q.get('q') ?? '', cb);
    case '/api/symbol': {
      const d = data.symbolDetail(Number(q.get('id')));
      if (!d) throw new HttpError(404, 'symbol not found');
      return d;
    }
    case '/api/file': {
      const d = data.fileDetail(Number(q.get('id')));
      if (!d) throw new HttpError(404, 'file not found');
      return d;
    }
    case '/api/graph/inheritance':
      return data.inheritanceGraph(q.get('root') ?? '', num(q.get('depth'), 2, 1, 5), oneOf(q.get('dir'), ['up', 'down', 'both'], 'both'), cb);
    case '/api/graph/calls': {
      const id = q.get('id');
      return data.callGraph(q.get('root') ?? '', id ? Number(id) : null, num(q.get('depth'), 2, 1, 4), oneOf(q.get('dir'), ['up', 'down', 'both'], 'both'), cb);
    }
    case '/api/graph/includes':
      return data.includeGraph(Number(q.get('id')), num(q.get('depth'), 2, 1, 4), oneOf(q.get('dir'), ['up', 'down', 'both'], 'both'));
    case '/api/graph/modules':
      if (cb === null) throw new HttpError(400, 'cb required');
      return data.moduleGraph(cb, num(q.get('depth'), 0, 0, 5), num(q.get('min'), 1, 1, 10000));
    default:
      throw new HttpError(404, 'unknown endpoint');
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Only answer requests addressed to loopback names: blocks DNS-rebinding from web pages. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!hostAllowed(req.headers.host)) { res.writeHead(403).end('forbidden'); return; }
  if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }

  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const body = JSON.stringify(route(url));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body);
      return;
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) logger.warn(`Viewer error on ${url.pathname}: ${err}`);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) }));
  }
}

let current: ViewerHandle | null = null;

/** Start (or reuse) the local viewer. Binds to 127.0.0.1 and tries the next ports when `port` is taken. */
export async function startViewer(port = 4177): Promise<ViewerHandle> {
  if (current) return current;

  const server = http.createServer(handler);
  const bound = await new Promise<number>((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) { attempt++; tryListen(); } else reject(err);
      });
      server.listen(port + attempt, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    };
    tryListen();
  });

  current = {
    url: `http://localhost:${bound}/`,
    port: bound,
    close: () => new Promise(resolve => {
      server.close(() => { current = null; resolve(); });
      server.closeAllConnections?.();
    }),
  };
  logger.info(`Viewer running at ${current.url}`);
  return current;
}
