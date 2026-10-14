import path from 'path';
import { getDb, prep } from '../db/database.js';

/**
 * Read-only queries behind the web viewer. Every graph is returned as { nodes, edges }
 * so the front end can use one renderer for all of them.
 */

export interface GNode {
  id: string;
  label: string;
  kind: string;            // class | struct | function | method | file | module | ghost ...
  title?: string;          // tooltip / secondary line
  group?: string;          // colour bucket (directory / module)
  size?: number;           // relative weight
  level?: number;          // layer hint for hierarchical layouts (negative = ancestors)
  root?: boolean;
  symbolId?: number;
  fileId?: number;
  badges?: string[];       // UE macros, e.g. UCLASS, BlueprintCallable
  ghost?: boolean;         // referenced but not indexed (engine class, external function...)
}

export interface GEdge {
  from: string;
  to: string;
  weight?: number;
  kind?: string;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  truncated?: boolean;
  note?: string;
}

const MAX_NODES = 400;
const FANOUT = 30;
const json = (xs: Iterable<unknown>) => JSON.stringify([...xs]);

const top = (rel: string, depth = 1): string =>
  rel.split(/[\\/]/).slice(0, Math.max(1, depth)).join('/') || '.';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function listCodebases() {
  return getDb().prepare(
    `SELECT c.id, c.name, c.root_path AS root, c.type, c.last_indexed_at AS lastIndexed,
            (SELECT COUNT(*) FROM files f WHERE f.codebase_id = c.id) AS files,
            (SELECT COUNT(*) FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.codebase_id = c.id) AS symbols
     FROM codebases c ORDER BY c.id`
  ).all();
}

/** Cheap fingerprint so the page can notice an incremental re-index and refresh itself. */
export function version(cb: number | null) {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS files, COALESCE(MAX(f.indexed_at), '') AS latest, COALESCE(SUM(f.file_size), 0) AS bytes
     FROM files f WHERE (@cb IS NULL OR f.codebase_id = @cb)`
  ).get({ cb }) as { files: number; latest: string; bytes: number };
  const syms = (getDb().prepare(
    `SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id WHERE (@cb IS NULL OR f.codebase_id = @cb)`
  ).get({ cb }) as { n: number }).n;
  return { token: `${row.files}:${row.latest}:${row.bytes}:${syms}`, ...row, symbols: syms };
}

export function overview(cb: number) {
  const db = getDb();
  const one = (sql: string, extra: Record<string, unknown> = {}) => db.prepare(sql).get({ cb, ...extra }) as any;
  const all = (sql: string, extra: Record<string, unknown> = {}) => db.prepare(sql).all({ cb, ...extra }) as any[];

  const scopeS = 'JOIN files f ON f.id = s.file_id WHERE f.codebase_id = @cb';

  const kinds = all(`SELECT s.kind, COUNT(*) AS n FROM symbols s ${scopeS} GROUP BY s.kind ORDER BY n DESC`);
  const macros = all(
    `SELECT m.macro_type AS type, COUNT(*) AS n FROM ue_macros m JOIN files f ON f.id = m.file_id
     WHERE f.codebase_id = @cb GROUP BY m.macro_type ORDER BY n DESC`);

  const calls = one(
    `SELECT COUNT(*) AS total, SUM(c.callee_symbol_id IS NOT NULL) AS resolved
     FROM calls c JOIN files f ON f.id = c.file_id WHERE f.codebase_id = @cb`);
  const includes = one(
    `SELECT COUNT(*) AS total, SUM(i.resolved_file_id IS NOT NULL) AS resolved, SUM(i.is_system) AS system
     FROM includes i JOIN files f ON f.id = i.file_id
     WHERE f.codebase_id = @cb AND i.included_path NOT LIKE '%.generated.h'`);
  const inheritance = one(
    `SELECT COUNT(*) AS total, SUM(i.parent_symbol_id IS NOT NULL) AS resolved
     FROM inheritance i JOIN symbols s ON s.id = i.child_symbol_id JOIN files f ON f.id = s.file_id
     WHERE f.codebase_id = @cb`);

  const blueprint = one(
    `SELECT COUNT(DISTINCT m.id) AS n FROM ue_macros m
     JOIN ue_macro_specifiers sp ON sp.macro_id = m.id JOIN files f ON f.id = m.file_id
     WHERE f.codebase_id = @cb AND m.macro_type IN ('UFUNCTION','UPROPERTY')
       AND sp.key IN ('BlueprintCallable','BlueprintPure','BlueprintReadWrite','BlueprintReadOnly',
                      'BlueprintImplementableEvent','BlueprintNativeEvent')`);

  const dirRows = all(
    `SELECT f.relative_path AS rel, COUNT(s.id) AS n FROM files f
     LEFT JOIN symbols s ON s.file_id = f.id WHERE f.codebase_id = @cb GROUP BY f.id`);
  const dirs = new Map<string, { files: number; symbols: number }>();
  for (const r of dirRows) {
    const d = top(r.rel, 2);
    const e = dirs.get(d) ?? { files: 0, symbols: 0 };
    e.files++; e.symbols += r.n;
    dirs.set(d, e);
  }

  return {
    kinds,
    macros,
    calls: { total: calls.total, resolved: calls.resolved ?? 0 },
    includes: { total: includes.total, resolved: includes.resolved ?? 0, system: includes.system ?? 0 },
    inheritance: { total: inheritance.total, resolved: inheritance.resolved ?? 0 },
    blueprintExposed: blueprint.n,
    directories: [...dirs.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.symbols - a.symbols).slice(0, 40),
    biggestClasses: all(
      `SELECT c.id, c.name, c.kind, f.relative_path AS file,
              (SELECT COUNT(*) FROM symbols m WHERE m.parent_symbol_id = c.id) AS members
       FROM symbols c JOIN files f ON f.id = c.file_id
       WHERE f.codebase_id = @cb AND c.kind IN ('class','struct') ORDER BY members DESC LIMIT 12`),
    mostCalled: all(
      `SELECT s.id, s.name, COALESCE(s.qualified_name, s.name) AS qname, COUNT(*) AS n
       FROM calls c JOIN symbols s ON s.id = c.callee_symbol_id JOIN files f ON f.id = s.file_id
       WHERE f.codebase_id = @cb GROUP BY s.id ORDER BY n DESC LIMIT 12`),
    mostIncluded: all(
      `SELECT t.id, t.relative_path AS file, COUNT(*) AS n
       FROM includes i JOIN files t ON t.id = i.resolved_file_id
       WHERE t.codebase_id = @cb GROUP BY t.id ORDER BY n DESC LIMIT 12`),
  };
}

// ---------------------------------------------------------------------------
// Search + details
// ---------------------------------------------------------------------------

export function search(q: string, cb: number | null, kinds: string[] | null, limit = 25) {
  const term = q.trim();
  if (!term) return [];
  const kindSql = kinds ? `AND s.kind IN (SELECT value FROM json_each(@kinds))` : '';
  const params = { cb, kinds: kinds ? json(kinds) : null, like: `%${term}%`, prefix: `${term}%`, exact: term, limit };
  return prep(
    `SELECT s.id, s.name, s.kind, COALESCE(s.qualified_name, s.name) AS qname, f.relative_path AS file, s.line_start AS line
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE (@cb IS NULL OR f.codebase_id = @cb) AND (s.name LIKE @like OR s.qualified_name LIKE @like) ${kindSql}
     ORDER BY (s.name = @exact) DESC, (s.name LIKE @prefix) DESC,
              (s.kind IN ('class','struct')) DESC, length(s.name), s.name
     LIMIT @limit`
  ).all(params);
}

export function searchFiles(q: string, cb: number | null, limit = 25) {
  return getDb().prepare(
    `SELECT f.id, f.relative_path AS file FROM files f
     WHERE (@cb IS NULL OR f.codebase_id = @cb) AND f.relative_path LIKE @like
     ORDER BY length(f.relative_path) LIMIT @limit`
  ).all({ cb, like: `%${q.trim()}%`, limit });
}

function macroBadges(symbolId: number): string[] {
  const rows = prep(
    `SELECT m.macro_type AS t, GROUP_CONCAT(sp.key) AS keys
     FROM ue_macros m LEFT JOIN ue_macro_specifiers sp ON sp.macro_id = m.id
     WHERE m.symbol_id = ? GROUP BY m.id`
  ).all(symbolId) as Array<{ t: string; keys: string | null }>;
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.t);
    for (const k of (r.keys ?? '').split(',')) if (k.startsWith('Blueprint')) out.push(k);
  }
  return [...new Set(out)];
}

export function symbolDetail(id: number) {
  const db = getDb();
  const s = db.prepare(
    `SELECT s.*, f.relative_path AS file, f.absolute_path AS abs FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
  ).get(id) as any;
  if (!s) return null;

  const macros = db.prepare(
    `SELECT m.macro_type AS type, GROUP_CONCAT(sp.key || COALESCE('=' || sp.value, ''), ', ') AS specifiers
     FROM ue_macros m LEFT JOIN ue_macro_specifiers sp ON sp.macro_id = m.id WHERE m.symbol_id = ? GROUP BY m.id`
  ).all(id);

  const isType = s.kind === 'class' || s.kind === 'struct' || s.kind === 'interface';
  const detail: any = {
    id: s.id, name: s.name, qname: s.qualified_name ?? s.name, kind: s.kind, file: s.file, abs: s.abs,
    line: s.line_start, signature: s.signature, returnType: s.return_type, access: s.access, macros,
  };

  if (isType) {
    detail.parents = db.prepare(
      `SELECT parent_name AS name, parent_symbol_id AS id, access FROM inheritance WHERE child_symbol_id = ?`).all(id);
    detail.children = db.prepare(
      `SELECT DISTINCT i.child_name AS name, i.child_symbol_id AS id FROM inheritance i
       WHERE i.parent_symbol_id = ? OR (i.parent_symbol_id IS NULL AND i.parent_name = ?) LIMIT 60`).all(id, s.name);
    detail.members = db.prepare(
      `SELECT m.id, m.name, m.kind, m.access, m.signature, m.return_type AS returnType, m.line_start AS line
       FROM symbols m WHERE m.parent_symbol_id = ? ORDER BY m.line_start LIMIT 200`).all(id)
      .map((m: any) => ({ ...m, badges: macroBadges(m.id) }));
  } else {
    detail.params = db.prepare(
      `SELECT name, type, default_value AS def FROM parameters WHERE symbol_id = ? ORDER BY position`).all(id);
    detail.callers = (db.prepare('SELECT COUNT(*) AS n FROM calls WHERE callee_symbol_id = ?').get(id) as any).n;
    detail.callees = (db.prepare('SELECT COUNT(*) AS n FROM calls WHERE caller_symbol_id = ?').get(id) as any).n;
    if (s.parent_symbol_id) {
      detail.owner = db.prepare('SELECT id, name FROM symbols WHERE id = ?').get(s.parent_symbol_id);
    }
  }
  return detail;
}

export function fileDetail(id: number) {
  const db = getDb();
  const f = db.prepare('SELECT id, relative_path AS file, absolute_path AS abs, file_size AS size, indexed_at AS indexedAt FROM files WHERE id = ?').get(id) as any;
  if (!f) return null;
  f.symbols = db.prepare(
    `SELECT id, name, kind, line_start AS line FROM symbols WHERE file_id = ? AND parent_symbol_id IS NULL ORDER BY line_start LIMIT 100`).all(id);
  f.includes = db.prepare(
    `SELECT i.included_path AS path, i.resolved_file_id AS id, i.is_system AS system FROM includes i WHERE i.file_id = ? ORDER BY i.line_number`).all(id);
  f.includedBy = (db.prepare('SELECT COUNT(*) AS n FROM includes WHERE resolved_file_id = ?').get(id) as any).n;
  return f;
}

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

type Dir = 'up' | 'down' | 'both';

interface TypeInfo {
  id: number; name: string; kind: string; file: string; fileId: number; line: number; members: number;
}

function typeInfo(name: string, cb: number | null): TypeInfo | undefined {
  return prep(
    `SELECT s.id, s.name, s.kind, f.relative_path AS file, f.id AS fileId, s.line_start AS line,
            (SELECT COUNT(*) FROM symbols m WHERE m.parent_symbol_id = s.id) AS members
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.name = ? AND s.kind IN ('class','struct','interface') AND (? IS NULL OR f.codebase_id = ?)
     ORDER BY members DESC, s.id LIMIT 1`
  ).get(name, cb, cb) as TypeInfo | undefined;
}

/** Class hierarchy around `root` (by class name). Engine/base classes that are not indexed show as ghosts. */
export function inheritanceGraph(root: string, depth: number, dir: Dir, cb: number | null): Graph {
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  let truncated = false;

  const ensure = (name: string, level: number): GNode | null => {
    let n = nodes.get(name);
    if (n) return n;
    if (nodes.size >= MAX_NODES) { truncated = true; return null; }
    const info = typeInfo(name, cb);
    n = {
      id: name, label: name, kind: info?.kind ?? 'ghost', level, ghost: !info,
      title: info ? `${info.file}:${info.line}` : 'not indexed (engine / external)',
      group: info ? top(info.file) : 'external',
      size: info ? Math.min(40, 6 + info.members) : 4,
      symbolId: info?.id, fileId: info?.fileId,
      badges: info ? macroBadges(info.id).filter(b => ['UCLASS', 'USTRUCT', 'UINTERFACE', 'BlueprintType', 'Blueprintable', 'Abstract'].includes(b)) : [],
    };
    nodes.set(name, n);
    return n;
  };

  const rootNode = ensure(root, 0);
  if (!rootNode) return { nodes: [], edges: [], note: `Class '${root}' not found` };
  rootNode.root = true;

  const parentsStmt = prep('SELECT DISTINCT parent_name AS n FROM inheritance WHERE child_name = ?');
  const childrenStmt = prep('SELECT DISTINCT child_name AS n FROM inheritance WHERE parent_name = ? LIMIT ?');

  const walk = (direction: 'up' | 'down') => {
    let frontier = [root];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const rows = (direction === 'up' ? parentsStmt.all(cur) : childrenStmt.all(cur, FANOUT * 2)) as Array<{ n: string }>;
        for (const { n } of rows) {
          const isNew = !nodes.has(n);
          const node = ensure(n, direction === 'up' ? -d : d);
          if (!node) continue;
          const [from, to] = direction === 'up' ? [n, cur] : [cur, n]; // edges point parent -> child
          edges.set(`${from}>${to}`, { from, to });
          if (isNew) next.push(n);
        }
      }
      frontier = next;
    }
  };
  if (dir !== 'down') walk('up');
  if (dir !== 'up') walk('down');

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

interface FnRow { id: number; name: string; qname: string; kind: string; file: string; fileId: number; line: number }

function fnInfo(id: number): FnRow | undefined {
  return prep(
    `SELECT s.id, s.name, COALESCE(s.qualified_name, s.name) AS qname, s.kind, f.relative_path AS file, f.id AS fileId, s.line_start AS line
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
  ).get(id) as FnRow | undefined;
}

/** Callers (up) and callees (down) of every function called `root` (or the symbol id given). */
export function callGraph(root: string, rootId: number | null, depth: number, dir: Dir, cb: number | null): Graph {
  const db = getDb();
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  let truncated = false;

  const symNode = (id: number, level: number): GNode | null => {
    const key = `s${id}`;
    let n = nodes.get(key);
    if (n) return n;
    if (nodes.size >= MAX_NODES) { truncated = true; return null; }
    const info = fnInfo(id);
    if (!info) return null;
    n = {
      id: key, label: info.qname.length > 34 ? info.name : info.qname, kind: info.kind, level, symbolId: id, fileId: info.fileId,
      title: `${info.qname}  —  ${info.file}:${info.line}`, group: top(info.file),
      badges: macroBadges(id).filter(b => b.startsWith('Blueprint') || b === 'UFUNCTION'),
    };
    nodes.set(key, n);
    return n;
  };
  const ghostNode = (name: string, level: number): GNode | null => {
    const key = `g:${name}`;
    let n = nodes.get(key);
    if (n) return n;
    if (nodes.size >= MAX_NODES) { truncated = true; return null; }
    n = { id: key, label: name, kind: 'ghost', ghost: true, level, title: 'not indexed (engine / external / unresolved)', group: 'external', size: 4 };
    nodes.set(key, n);
    return n;
  };

  const rootIds: number[] = rootId
    ? [rootId]
    : (db.prepare(
        `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE (s.name = @n OR s.qualified_name = @n) AND s.kind IN ('function','method','constructor','destructor')
           AND (@cb IS NULL OR f.codebase_id = @cb)
         ORDER BY (SELECT COUNT(*) FROM calls c WHERE c.callee_symbol_id = s.id) DESC LIMIT 6`
      ).all({ n: root, cb }) as Array<{ id: number }>).map(r => r.id);

  if (rootIds.length === 0) return { nodes: [], edges: [], note: `Function '${root}' not found` };
  for (const id of rootIds) { const n = symNode(id, 0); if (n) n.root = true; }

  const calleesStmt = prep(
    `SELECT callee_symbol_id AS id, callee_name AS name, COUNT(*) AS n FROM calls
     WHERE caller_symbol_id = ? GROUP BY callee_symbol_id, callee_name ORDER BY n DESC LIMIT ?`);
  const callersStmt = prep(
    `SELECT caller_symbol_id AS id, caller_name AS name, COUNT(*) AS n FROM calls
     WHERE callee_symbol_id = ? AND caller_symbol_id IS NOT NULL GROUP BY caller_symbol_id ORDER BY n DESC LIMIT ?`);
  // calls to a root name that never resolved still matter when the root itself is a ghost-ish name
  const unresolvedCallersStmt = prep(
    `SELECT caller_symbol_id AS id, COUNT(*) AS n FROM calls
     WHERE callee_symbol_id IS NULL AND callee_name = ? AND caller_symbol_id IS NOT NULL GROUP BY caller_symbol_id LIMIT ?`);

  const walk = (direction: 'up' | 'down') => {
    let frontier = rootIds.map(id => `s${id}`);
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const key of frontier) {
        const id = Number(key.slice(1));
        const level = direction === 'up' ? -d : d;
        if (direction === 'down') {
          for (const r of calleesStmt.all(id, FANOUT) as Array<{ id: number | null; name: string; n: number }>) {
            const isNew = r.id ? !nodes.has(`s${r.id}`) : !nodes.has(`g:${r.name}`);
            const node = r.id ? symNode(r.id, level) : ghostNode(r.name, level);
            if (!node) continue;
            edges.set(`${key}>${node.id}`, { from: key, to: node.id, weight: r.n });
            if (isNew && r.id) next.push(node.id);
          }
        } else {
          for (const r of callersStmt.all(id, FANOUT) as Array<{ id: number; n: number }>) {
            const isNew = !nodes.has(`s${r.id}`);
            const node = symNode(r.id, level);
            if (!node) continue;
            edges.set(`${node.id}>${key}`, { from: node.id, to: key, weight: r.n });
            if (isNew) next.push(node.id);
          }
          if (d === 1) {
            const nm = nodes.get(key)?.label.split('::').pop() ?? '';
            for (const r of unresolvedCallersStmt.all(nm, FANOUT) as Array<{ id: number; n: number }>) {
              const node = symNode(r.id, level);
              if (node) edges.set(`${node.id}>${key}`, { from: node.id, to: key, weight: r.n });
            }
          }
        }
      }
      frontier = next;
    }
  };
  if (dir !== 'up') walk('down');
  if (dir !== 'down') walk('up');

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

/** #include graph around a file: what it includes (down) and who includes it (up). */
export function includeGraph(fileId: number, depth: number, dir: Dir): Graph {
  const nodes = new Map<number, GNode>();
  const edges = new Map<string, GEdge>();
  let truncated = false;

  const fileNode = (id: number, level: number): GNode | null => {
    let n = nodes.get(id);
    if (n) return n;
    if (nodes.size >= MAX_NODES) { truncated = true; return null; }
    const f = prep('SELECT relative_path AS rel FROM files WHERE id = ?').get(id) as { rel: string } | undefined;
    if (!f) return null;
    const incoming = (prep('SELECT COUNT(*) AS n FROM includes WHERE resolved_file_id = ?').get(id) as { n: number }).n;
    n = {
      id: `f${id}`, label: path.basename(f.rel), kind: 'file', level, fileId: id, title: f.rel,
      group: top(f.rel, 2), size: Math.min(36, 5 + Math.sqrt(incoming) * 2),
    };
    nodes.set(id, n);
    return n;
  };

  const root = fileNode(fileId, 0);
  if (!root) return { nodes: [], edges: [], note: 'File not found' };
  root.root = true;

  const down = prep('SELECT DISTINCT resolved_file_id AS id FROM includes WHERE file_id = ? AND resolved_file_id IS NOT NULL LIMIT ?');
  const up = prep('SELECT DISTINCT file_id AS id FROM includes WHERE resolved_file_id = ? LIMIT ?');

  const walk = (direction: 'up' | 'down') => {
    let frontier = [fileId];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: number[] = [];
      for (const cur of frontier) {
        const rows = (direction === 'down' ? down : up).all(cur, FANOUT) as Array<{ id: number }>;
        for (const { id } of rows) {
          const isNew = !nodes.has(id);
          const node = fileNode(id, direction === 'down' ? d : -d);
          if (!node) continue;
          const [a, b] = direction === 'down' ? [cur, id] : [id, cur]; // edge = "includes"
          edges.set(`${a}>${b}`, { from: `f${a}`, to: `f${b}` });
          if (isNew) next.push(id);
        }
      }
      frontier = next;
    }
  };
  if (dir !== 'up') walk('down');
  if (dir !== 'down') walk('up');

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

/**
 * Directory-level dependency map: nodes are folders (to `depth` segments), edges are aggregated #includes.
 * depth 0 = auto: the shallowest depth that yields at least 4 folders (so Source/<Module>/Public/... lands on modules).
 */
export function moduleGraph(cb: number, depth: number, minEdge: number): Graph & { depth: number } {
  const db = getDb();
  const files = db.prepare(
    `SELECT f.id, f.relative_path AS rel, COUNT(s.id) AS syms FROM files f
     LEFT JOIN symbols s ON s.file_id = f.id WHERE f.codebase_id = ? GROUP BY f.id`
  ).all(cb) as Array<{ id: number; rel: string; syms: number }>;

  const folderOf = (rel: string, d: number) => {
    const dir = path.dirname(rel);
    return dir === '.' ? '(root)' : top(dir, d);
  };
  if (depth === 0) {
    depth = 4;
    for (let d = 1; d <= 4; d++) {
      if (new Set(files.map(f => folderOf(f.rel, d))).size >= 4) { depth = d; break; }
    }
  }

  const groupOf = new Map<number, string>();
  const stats = new Map<string, { files: number; symbols: number }>();
  for (const f of files) {
    const g = folderOf(f.rel, depth);
    groupOf.set(f.id, g);
    const s = stats.get(g) ?? { files: 0, symbols: 0 };
    s.files++; s.symbols += f.syms;
    stats.set(g, s);
  }

  const inc = db.prepare(
    `SELECT i.file_id AS a, i.resolved_file_id AS b FROM includes i JOIN files f ON f.id = i.file_id
     WHERE f.codebase_id = ? AND i.resolved_file_id IS NOT NULL`
  ).all(cb) as Array<{ a: number; b: number }>;

  const agg = new Map<string, number>();
  for (const { a, b } of inc) {
    const ga = groupOf.get(a), gb = groupOf.get(b);
    if (!ga || !gb || ga === gb) continue;
    const k = `${ga}\u0000${gb}`;
    agg.set(k, (agg.get(k) ?? 0) + 1);
  }

  const edges: GEdge[] = [];
  const used = new Set<string>();
  for (const [k, w] of agg) {
    if (w < minEdge) continue;
    const [a, b] = k.split('\u0000');
    edges.push({ from: a, to: b, weight: w });
    used.add(a); used.add(b);
  }

  const nodes: GNode[] = [...stats.entries()]
    .filter(([name]) => used.has(name) || stats.size <= 60)
    .map(([name, s]) => ({
      id: name, label: name, kind: 'module', group: name.split('/')[0],
      size: Math.min(48, 6 + Math.sqrt(s.symbols) * 0.6), title: `${s.files} files · ${s.symbols} symbols`,
    }));

  return { nodes, edges, truncated: nodes.length > MAX_NODES, depth };
}
