// Integration test for incremental indexing. Run: npm run build && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfig } from '../build/config.js';
import { getDb, closeDb } from '../build/db/database.js';
import { indexCodebase, reindexPaths } from '../build/indexer/pipeline.js';
import { CodebaseWatcher } from '../build/indexer/watcher.js';
import { shutdownParsePool } from '../build/indexer/worker-pool.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-codegraph-test-'));
const root = path.join(tmp, 'Source');
const w = (name, text) => {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

const BASE_H = 'class UBase\n{\npublic:\n  virtual void Ping();\n};\n';
const DERIVED_H = '#include "Base.h"\nclass UDerived : public UBase\n{\npublic:\n  void Run();\n};\n';
const DERIVED_CPP = '#include "Derived.h"\nvoid UDerived::Run()\n{\n  Ping();\n}\n';
const OTHER_H = 'class UOther\n{\npublic:\n  void Idle();\n};\n';

let db;
let codebaseId;

const fileId = rel => db.prepare('SELECT id FROM files WHERE relative_path = ?').get(rel)?.id;
const symbolIds = rel => db.prepare('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.relative_path = ? ORDER BY s.id').all(rel).map(r => r.id);
const parentLink = () => db.prepare(
  `SELECT i.parent_symbol_id AS pid, p.name AS pname, pf.relative_path AS pfile
   FROM inheritance i LEFT JOIN symbols p ON p.id = i.parent_symbol_id LEFT JOIN files pf ON pf.id = p.file_id
   WHERE i.child_name = 'UDerived'`
).get();
const includeLink = () => db.prepare(
  `SELECT i.resolved_file_id AS rid FROM includes i JOIN files f ON f.id = i.file_id
   WHERE f.relative_path = 'Derived.h' AND i.included_path = 'Base.h'`
).get()?.rid;

before(() => {
  // workers on, threshold 1 so even this tiny project exercises the worker pool
  setConfig({ dbPath: path.join(tmp, 'index.db'), workers: 2, parallelThreshold: 1 });
  db = getDb();
  w('Base.h', BASE_H);
  w('Derived.h', DERIVED_H);
  w('Derived.cpp', DERIVED_CPP);
  w('Other.h', OTHER_H);
  w('Intermediate/Generated.h', 'class UGenerated {};\n');
});

after(async () => {
  await shutdownParsePool();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('initial index is full and links across files', async () => {
  const r = await indexCodebase(root, 'test', 'project');
  codebaseId = r.codebaseId;
  assert.equal(r.mode, 'full');
  assert.equal(r.totalFiles, 4, 'Intermediate/ is excluded');
  assert.equal(r.newFiles, 4);

  const link = parentLink();
  assert.equal(link.pname, 'UBase');
  assert.equal(link.pfile, 'Base.h');
  assert.equal(includeLink(), fileId('Base.h'));
});

test('re-running with no edits parses nothing', async () => {
  const r = await indexCodebase(root, 'test', 'project');
  assert.equal(r.newFiles + r.changedFiles + r.deletedFiles, 0);
  assert.equal(r.unchangedFiles, 4);
});

test('editing one file re-parses only that file and keeps others untouched', async () => {
  const before = { derived: symbolIds('Derived.h'), cpp: symbolIds('Derived.cpp'), other: symbolIds('Other.h') };
  const baseFileId = fileId('Base.h');

  w('Base.h', BASE_H.replace('virtual void Ping();', 'virtual void Ping();\n  void Pong();'));
  const r = await indexCodebase(root, 'test', 'project');

  assert.equal(r.changedFiles, 1);
  assert.equal(r.newFiles, 0);
  assert.equal(r.mode, 'incremental');
  assert.deepEqual(symbolIds('Derived.h'), before.derived, 'dependent header not re-parsed');
  assert.deepEqual(symbolIds('Derived.cpp'), before.cpp, 'dependent source not re-parsed');
  assert.deepEqual(symbolIds('Other.h'), before.other);
  assert.equal(fileId('Base.h'), baseFileId, 'file row (and id) is kept so incoming includes stay valid');
  assert.equal(includeLink(), baseFileId);

  // the base-class link must follow the re-created UBase symbol, not dangle or vanish
  const link = parentLink();
  assert.equal(link.pname, 'UBase');
  const newBase = db.prepare("SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name='UBase' AND f.relative_path='Base.h'").get();
  assert.equal(link.pid, newBase.id);
});

test('references held by other files survive re-indexing the header they point to', async () => {
  const refsInDerived = () => db.prepare(
    "SELECT COUNT(*) AS n FROM references_table r JOIN files f ON f.id = r.file_id WHERE f.relative_path IN ('Derived.h','Derived.cpp')"
  ).get().n;
  const before = refsInDerived();
  await reindexPaths([path.join(root, 'Base.h')], { force: true });
  assert.equal(refsInDerived(), before);
});

test('deleting a header unlinks dependents; restoring it relinks them', async () => {
  fs.rmSync(path.join(root, 'Base.h'));
  let r = await reindexPaths([path.join(root, 'Base.h')]);
  assert.equal(r.deleted, 1);
  assert.equal(fileId('Base.h'), undefined);
  assert.equal(parentLink().pid, null);
  assert.equal(includeLink(), null);

  w('Base.h', BASE_H);
  r = await reindexPaths([path.join(root, 'Base.h')]);
  assert.equal(r.indexed, 1);
  assert.equal(parentLink().pname, 'UBase', 'inheritance relinked');
  assert.equal(includeLink(), fileId('Base.h'), 'include relinked');
});

test('unchanged content is skipped, ignored paths are ignored', async () => {
  const r = await reindexPaths([path.join(root, 'Other.h'), path.join(root, 'Intermediate', 'Generated.h'), path.join(root, 'notes.txt')]);
  assert.equal(r.indexed, 0);
  assert.equal(r.skipped, 3);
});

test('paths outside every codebase are reported', async () => {
  const r = await reindexPaths([path.join(tmp, 'elsewhere.h')]);
  assert.equal(r.success, false);
});

test('file watcher picks up create / edit / delete', async () => {
  const watcher = new CodebaseWatcher(root, false);
  watcher.start();
  try {
    const waitFor = async (cond, ms = 6000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (cond()) return true;
        await new Promise(res => setTimeout(res, 100));
      }
      return false;
    };

    w('Added.h', 'class UAdded\n{\npublic:\n  void Go();\n};\n');
    assert.ok(await waitFor(() => fileId('Added.h') !== undefined), 'new file indexed');

    w('Added.h', 'class UAdded\n{\npublic:\n  void Go();\n  void Stop();\n};\n');
    assert.ok(await waitFor(() => db.prepare("SELECT 1 FROM symbols WHERE name='Stop'").get() !== undefined), 'edit indexed');

    fs.rmSync(path.join(root, 'Added.h'));
    assert.ok(await waitFor(() => fileId('Added.h') === undefined), 'deleted file removed');
    assert.equal(db.prepare("SELECT 1 FROM symbols WHERE name='UAdded'").get(), undefined);
  } finally {
    watcher.stop();
  }
});

test('same-named methods resolve to the symbol in the include closure', async () => {
  w('A.h', 'class UA\n{\npublic:\n  void Tick();\n};\n');
  w('B.h', 'class UB\n{\npublic:\n  void Tick();\n};\n');
  w('UseB.h', '#include "B.h"\nclass UUser\n{\npublic:\n  void Update()\n  {\n    Tick();\n  }\n};\n');
  await reindexPaths([path.join(root, 'A.h'), path.join(root, 'B.h'), path.join(root, 'UseB.h')], { force: true });

  const row = db.prepare(
    `SELECT tf.relative_path AS target
     FROM calls c JOIN files cf ON cf.id = c.file_id
     JOIN symbols t ON t.id = c.callee_symbol_id JOIN files tf ON tf.id = t.file_id
     WHERE cf.relative_path = 'UseB.h' AND c.callee_name = 'Tick'`
  ).get();
  assert.equal(row?.target, 'B.h');
});

test('UCLASS attaches to the class, not to its same-named constructor', async () => {
  w('Macro.h', 'UCLASS(Blueprintable)\nclass UMacroHolder\n{\n  GENERATED_BODY()\npublic:\n  UMacroHolder();\n};\n');
  await reindexPaths([path.join(root, 'Macro.h')], { force: true });
  const row = db.prepare(
    `SELECT s.kind FROM ue_macros m JOIN symbols s ON s.id = m.symbol_id JOIN files f ON f.id = m.file_id
     WHERE f.relative_path = 'Macro.h' AND m.macro_type = 'UCLASS'`
  ).get();
  assert.equal(row?.kind, 'class');
});
