// Tests for codebase scope (include_dirs / exclude) and overlapping codebases. Run: npm run build && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfig } from '../build/config.js';
import { getDb, closeDb } from '../build/db/database.js';
import { indexCodebase, reindexPaths } from '../build/indexer/pipeline.js';
import { isIndexablePath } from '../build/indexer/file-discovery.js';
import { shutdownParsePool } from '../build/indexer/worker-pool.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-codegraph-scope-'));
const project = path.join(tmp, 'Client');
const w = (rel, text) => {
  const p = path.join(project, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

let db;
const files = id => db.prepare('SELECT relative_path AS p FROM files WHERE codebase_id = ? ORDER BY p').all(id).map(r => r.p.replace(/\\/g, '/'));
const codebase = id => db.prepare('SELECT * FROM codebases WHERE id = ?').get(id);
const incLink = id => db.prepare(
  `SELECT i.resolved_file_id AS rid FROM includes i JOIN files f ON f.id = i.file_id
   WHERE f.codebase_id = ? AND i.included_path = 'PluginThing.h'`
).get(id)?.rid;

before(() => {
  setConfig({ dbPath: path.join(tmp, 'index.db'), workers: 0 });
  db = getDb();
  w('Source/Game.h', '#include "PluginThing.h"\nclass AGame : public UPluginThing\n{\npublic:\n  void Tick();\n};\n');
  w('Plugins/Foo/Source/PluginThing.h', 'class UPluginThing\n{\npublic:\n  virtual void Ping();\n};\n');
  w('Plugins/Foo/Source/Tests/PluginTest.h', 'class UPluginTest {};\n');
  w('Content/Junk.h', 'class UJunk {};\n');
});

after(async () => {
  await shutdownParsePool();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('include dirs + extra excludes restrict discovery; cross-folder links resolve', async () => {
  const r = await indexCodebase(project, 'All', 'project', false, {
    includeDirs: ['Source', 'Plugins'],
    excludePatterns: ['**/Tests/**'],
  });
  assert.deepEqual(files(r.codebaseId), ['Plugins/Foo/Source/PluginThing.h', 'Source/Game.h']);
  assert.ok(incLink(r.codebaseId), 'Source -> Plugins include resolves inside one codebase');
  const inh = db.prepare(`SELECT parent_symbol_id AS pid FROM inheritance WHERE child_name = 'AGame'`).get();
  assert.ok(inh?.pid, 'Source class -> plugin base class resolves');
});

test('scope is persisted and reused when omitted on the next run', async () => {
  const r = await indexCodebase(project, 'All', 'project');
  assert.equal(r.newFiles + r.changedFiles + r.deletedFiles, 0);
  assert.deepEqual(JSON.parse(codebase(r.codebaseId).include_dirs), ['Source', 'Plugins']);
});

test('paths outside the scope are not indexable (watcher / reindex filter)', () => {
  const scope = { includeDirs: ['Source', 'Plugins'], excludePatterns: ['**/Tests/**'] };
  assert.equal(isIndexablePath(project, path.join(project, 'Source/Game.h'), false, scope), true);
  assert.equal(isIndexablePath(project, path.join(project, 'Content/Junk.h'), false, scope), false);
  assert.equal(isIndexablePath(project, path.join(project, 'Plugins/Foo/Source/Tests/PluginTest.h'), false, scope), false);
  assert.equal(isIndexablePath(project, path.join(project, 'SourceExtra/X.h'), false, scope), false, 'prefix match must be per folder');
});

test('narrowing the scope removes files that fall out of it', async () => {
  const r = await indexCodebase(project, 'All', 'project', false, { includeDirs: ['Source'] });
  assert.equal(r.deletedFiles, 1);
  assert.deepEqual(files(r.codebaseId), ['Source/Game.h']);
  assert.equal(incLink(r.codebaseId) ?? null, null, "link is gone once the plugin folder is out of scope");
});

test('overlapping codebases keep separate rows and are all updated by reindexPaths', async () => {
  const all = await indexCodebase(project, 'All', 'project', false, { includeDirs: ['Source', 'Plugins'] });
  const src = await indexCodebase(path.join(project, 'Source'), 'Src', 'project');
  assert.notEqual(all.codebaseId, src.codebaseId);
  assert.deepEqual(files(src.codebaseId), ['Game.h']);
  assert.ok(files(all.codebaseId).includes('Source/Game.h'), 'indexing the inner codebase must not steal the outer one\'s row');

  const game = path.join(project, 'Source/Game.h');
  fs.writeFileSync(game, fs.readFileSync(game, 'utf8') + 'class AExtra {};\n');
  const s = await reindexPaths([game]);
  assert.equal(s.indexed, 2, 'both codebases re-parse the edited file');
  for (const id of [all.codebaseId, src.codebaseId]) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.codebase_id = ? AND s.name = 'AExtra'`).get(id).n;
    assert.equal(n, 1);
  }
});
