import path from 'path';
import type Database from 'better-sqlite3';
import { getDb, prep } from '../db/database.js';
import { logger } from '../utils/logger.js';

/**
 * What an incremental run touched. Resolution is limited to rows that could be affected:
 *  - everything written by files in `fileIds` (their own outgoing links),
 *  - unresolved rows anywhere whose target name is in `names` (a symbol with that name was re-created;
 *    deleting the old row set the links that pointed at it to NULL),
 *  - includes whose basename is in `basenames` (a header was added/removed),
 *  - files transitively including a file in `includeChangedFileIds` (their include closure moved,
 *    which changes how same-named symbols are ranked).
 * A `null` scope means "resolve everything" (first index / large change sets).
 */
export interface ResolveScope {
  fileIds: Set<number>;
  names: Set<string>;
  basenames: Set<string>;
  includeChangedFileIds: Set<number>;
}

export function emptyScope(): ResolveScope {
  return { fileIds: new Set(), names: new Set(), basenames: new Set(), includeChangedFileIds: new Set() };
}

export interface ResolveStats {
  includesResolved: number;
  relinkedFiles: number | 'all';
}

const FUNCTION_KINDS = "('function','method','constructor','destructor')";
const CLASS_KINDS = "('class','struct','interface')";

const CLOSURE_DEPTH = 3;
const CLOSURE_CAP = 3000;
const CANDIDATE_CAP = 200;

const toJson = (set: Iterable<unknown>) => JSON.stringify([...set]);

// ---------------------------------------------------------------------------
// Includes
// ---------------------------------------------------------------------------

function resolveIncludes(
  db: Database.Database,
  codebaseId: number,
  scope: ResolveScope | null,
): { resolved: number; touched: Set<number> } {
  const files = prep(
    'SELECT id, relative_path FROM files WHERE codebase_id = ?'
  ).all(codebaseId) as Array<{ id: number; relative_path: string }>;

  const norm = (p: string) => p.replace(/\\/g, '/');
  const byRelative = new Map<string, number>();
  const byFilename = new Map<string, Array<{ id: number; rel: string }>>();
  for (const f of files) {
    const rel = norm(f.relative_path);
    byRelative.set(rel, f.id);
    const name = path.posix.basename(rel);
    let list = byFilename.get(name);
    if (!list) byFilename.set(name, (list = []));
    list.push({ id: f.id, rel });
  }

  const unresolved = prep(
    `SELECT i.id, i.included_path, i.file_id
     FROM includes i JOIN files f ON i.file_id = f.id
     WHERE f.codebase_id = ? AND i.resolved_file_id IS NULL AND i.is_system = 0`
  ).all(codebaseId) as Array<{ id: number; included_path: string; file_id: number }>;

  const updates: Array<{ includeId: number; fileId: number }> = [];
  const touched = new Set<number>();

  for (const inc of unresolved) {
    const includePath = norm(inc.included_path);
    const filename = path.posix.basename(includePath);
    if (scope && !scope.fileIds.has(inc.file_id) && !scope.basenames.has(filename)) continue;

    let resolvedId = byRelative.get(includePath);
    if (!resolvedId) {
      const candidates = byFilename.get(filename);
      if (candidates) {
        resolvedId = candidates.length === 1
          ? candidates[0].id
          : candidates.find(c => c.rel.endsWith(includePath))?.id;
      }
    }
    if (resolvedId && resolvedId !== inc.file_id) {
      updates.push({ includeId: inc.id, fileId: resolvedId });
      touched.add(inc.file_id);
    }
  }

  const stmt = prep('UPDATE includes SET resolved_file_id = ? WHERE id = ?');
  db.transaction(() => { for (const u of updates) stmt.run(u.fileId, u.includeId); })();
  return { resolved: updates.length, touched };
}

/** Files that (transitively, up to `depth` hops) include any of `seeds`. */
export function collectDependents(db: Database.Database, seeds: Set<number>, depth: number): Set<number> {
  const result = new Set<number>();
  if (seeds.size === 0) return result;
  const stmt = prep(
    'SELECT DISTINCT file_id AS id FROM includes WHERE resolved_file_id IN (SELECT value FROM json_each(?))'
  );
  let frontier = new Set(seeds);
  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const next = new Set<number>();
    for (const row of stmt.all(toJson(frontier)) as Array<{ id: number }>) {
      if (!result.has(row.id) && !seeds.has(row.id)) { result.add(row.id); next.add(row.id); }
    }
    frontier = next;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Symbol ranking (include-aware)
// ---------------------------------------------------------------------------

interface Candidate { id: number; fileId: number; stem: string }

const stemOf = (relPath: string) => path.basename(relPath).replace(/\.[^.]*$/, '').toLowerCase();

/**
 * Picks which same-named symbol a call/reference/base-class most likely means:
 * same file > paired header/source (Foo.cpp <-> Foo.h) > directly included > included via 2 / 3 hops > anything.
 * Previously the first match won, which is arbitrary for names like Tick or BeginPlay.
 */
class Ranker {
  private candCache = new Map<string, Candidate[]>();
  private fileStem = new Map<number, string>();
  private closureCache = new Map<number, Map<number, number>>();
  private edges: Map<number, number[]> | null = null;

  constructor(private db: Database.Database, private codebaseId: number) {}

  private candidates(name: string, kinds: string | null): Candidate[] {
    const key = `${kinds ?? '*'}|${name}`;
    let list = this.candCache.get(key);
    if (!list) {
      const rows = prep(
        `SELECT s.id, s.file_id AS fileId, f.relative_path AS rel
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name = ? AND f.codebase_id = ? ${kinds ? `AND s.kind IN ${kinds}` : ''}
         ORDER BY s.id LIMIT ${CANDIDATE_CAP}`
      ).all(name, this.codebaseId) as Array<{ id: number; fileId: number; rel: string }>;
      list = rows.map(r => ({ id: r.id, fileId: r.fileId, stem: stemOf(r.rel) }));
      this.candCache.set(key, list);
    }
    return list;
  }

  private stem(fileId: number): string {
    let s = this.fileStem.get(fileId);
    if (s === undefined) {
      const row = prep('SELECT relative_path AS rel FROM files WHERE id = ?').get(fileId) as { rel: string } | undefined;
      s = row ? stemOf(row.rel) : '';
      this.fileStem.set(fileId, s);
    }
    return s;
  }

  /** fileId -> hop distance (1..CLOSURE_DEPTH) over resolved includes */
  private closure(fileId: number): Map<number, number> {
    let cl = this.closureCache.get(fileId);
    if (cl) return cl;

    if (!this.edges) {
      this.edges = new Map();
      const rows = prep(
        `SELECT i.file_id AS a, i.resolved_file_id AS b
         FROM includes i JOIN files f ON f.id = i.file_id
         WHERE f.codebase_id = ? AND i.resolved_file_id IS NOT NULL`
      ).all(this.codebaseId) as Array<{ a: number; b: number }>;
      for (const { a, b } of rows) {
        const list = this.edges.get(a);
        if (list) list.push(b); else this.edges.set(a, [b]);
      }
    }

    cl = new Map();
    let frontier = [fileId];
    for (let depth = 1; depth <= CLOSURE_DEPTH && frontier.length > 0 && cl.size < CLOSURE_CAP; depth++) {
      const next: number[] = [];
      for (const f of frontier) {
        for (const t of this.edges.get(f) ?? []) {
          if (t !== fileId && !cl.has(t)) { cl.set(t, depth); next.push(t); }
        }
      }
      frontier = next;
    }
    this.closureCache.set(fileId, cl);
    return cl;
  }

  pick(name: string, kinds: string | null, callerFileId: number): number | null {
    const cands = this.candidates(name, kinds);
    if (cands.length === 0) return null;
    if (cands.length === 1) return cands[0].id;

    const callerStem = this.stem(callerFileId);
    const closure = this.closure(callerFileId);
    let best = cands[0];
    let bestScore = -1;
    for (const c of cands) {
      let score = 0;
      if (c.fileId === callerFileId) score = 100;
      else if (c.stem === callerStem) score = 80;
      else {
        const hops = closure.get(c.fileId);
        if (hops) score = 75 - hops * 15; // 60 / 45 / 30
      }
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best.id;
  }
}

// ---------------------------------------------------------------------------
// Link tables
// ---------------------------------------------------------------------------

interface LinkSpec {
  label: string;
  kinds: string | null;
  /** distinct (fid, name) pairs; `{scope}` is replaced by the scope predicate or '' */
  pairs: string;
  scope: string;
  update: string;
}

const SPECS: LinkSpec[] = [
  {
    label: 'inheritance',
    kinds: CLASS_KINDS,
    pairs: `SELECT DISTINCT s.file_id AS fid, i.parent_name AS name
            FROM inheritance i
            JOIN symbols s ON s.id = i.child_symbol_id
            JOIN files f ON f.id = s.file_id
            WHERE f.codebase_id = @cb {scope}`,
    scope: 'AND (s.file_id IN (SELECT value FROM json_each(@files)) OR (i.parent_name IN (SELECT value FROM json_each(@names)) AND i.parent_symbol_id IS NULL))',
    update: `UPDATE inheritance SET parent_symbol_id = @id
             WHERE parent_name = @name AND parent_symbol_id IS NOT @id
               AND child_symbol_id IN (SELECT id FROM symbols WHERE file_id = @fid)`,
  },
  {
    label: 'calls',
    kinds: FUNCTION_KINDS,
    pairs: `SELECT DISTINCT c.file_id AS fid, c.callee_name AS name
            FROM calls c JOIN files f ON f.id = c.file_id
            WHERE f.codebase_id = @cb {scope}`,
    scope: 'AND (c.file_id IN (SELECT value FROM json_each(@files)) OR (c.callee_name IN (SELECT value FROM json_each(@names)) AND c.callee_symbol_id IS NULL))',
    update: `UPDATE calls SET callee_symbol_id = @id
             WHERE file_id = @fid AND callee_name = @name AND callee_symbol_id IS NOT @id`,
  },
  {
    label: 'references',
    kinds: null,
    pairs: `SELECT DISTINCT r.file_id AS fid, r.symbol_name AS name
            FROM references_table r JOIN files f ON f.id = r.file_id
            WHERE f.codebase_id = @cb {scope}`,
    scope: 'AND (r.file_id IN (SELECT value FROM json_each(@files)) OR (r.symbol_name IN (SELECT value FROM json_each(@names)) AND r.symbol_id IS NULL))',
    update: `UPDATE references_table SET symbol_id = @id
             WHERE file_id = @fid AND symbol_name = @name AND symbol_id IS NOT @id`,
  },
];

function relink(
  db: Database.Database,
  ranker: Ranker,
  codebaseId: number,
  spec: LinkSpec,
  files: Set<number> | null,
  names: Set<string> | null,
): void {
  const sql = spec.pairs.replace('{scope}', files ? spec.scope : '');
  const params: Record<string, unknown> = { cb: codebaseId };
  if (files) { params.files = toJson(files); params.names = toJson(names ?? []); }

  const pairs = prep(sql).all(params) as Array<{ fid: number; name: string }>;
  const update = prep(spec.update);

  db.transaction(() => {
    for (const { fid, name } of pairs) {
      const id = ranker.pick(name, spec.kinds, fid);
      if (id !== null) update.run({ id, fid, name });
    }
  })();
}

/**
 * Link names to symbol/file ids. With a scope only the affected rows are revisited.
 */
export function resolveLinks(codebaseId: number, scope: ResolveScope | null): ResolveStats {
  const db = getDb();

  const inc = resolveIncludes(db, codebaseId, scope);

  let files: Set<number> | null = null;
  let names: Set<string> | null = null;
  if (scope) {
    files = new Set([...scope.fileIds, ...inc.touched]);
    for (const dep of collectDependents(db, scope.includeChangedFileIds, 2)) files.add(dep);
    names = scope.names;
  }

  const ranker = new Ranker(db, codebaseId);
  for (const spec of SPECS) relink(db, ranker, codebaseId, spec, files, names);

  logger.info(`Resolution: ${inc.resolved} includes, ${files ? files.size : 'all'} files relinked`);
  return { includesResolved: inc.resolved, relinkedFiles: files ? files.size : 'all' };
}
