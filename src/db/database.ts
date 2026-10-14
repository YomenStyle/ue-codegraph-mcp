import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema.js';
import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const config = getConfig();
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    _db = new Database(config.dbPath);
    configurePragmas(_db, config);
    initSchema(_db);
    logger.info(`Database opened: ${config.dbPath}`);
  }
  return _db;
}

function configurePragmas(db: Database.Database, config: { cacheSize: number; mmapSize: number }): void {
  db.pragma('journal_mode = WAL');
  db.pragma(`cache_size = -${config.cacheSize * 1024}`); // negative = KB
  db.pragma(`mmap_size = ${config.mmapSize * 1024 * 1024}`);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000'); // CLI / watcher / MCP server may share the DB file
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
}

function initSchema(db: Database.Database): void {
  db.exec(SCHEMA_DDL);
  migrate(db);
  logger.info('Schema initialized');
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

/**
 * Upgrade databases created by older versions. Every step is idempotent so a fresh
 * database (already in the latest shape) passes through untouched.
 *  v3: codebases.include_dirs / exclude_patterns (JSON arrays: sub-folder scope + extra excludes)
 *  v2: codebases.headers_only, references_table.symbol_id ON DELETE SET NULL
 *      (CASCADE used to wipe references held by *other* files when a symbol's file was re-indexed)
 */
function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  db.transaction(() => {
    if (!hasColumn(db, 'codebases', 'headers_only')) {
      db.exec(`ALTER TABLE codebases ADD COLUMN headers_only INTEGER NOT NULL DEFAULT 0`);
    }

    if (!hasColumn(db, 'codebases', 'include_dirs')) {
      db.exec(`ALTER TABLE codebases ADD COLUMN include_dirs TEXT`);
    }
    if (!hasColumn(db, 'codebases', 'exclude_patterns')) {
      db.exec(`ALTER TABLE codebases ADD COLUMN exclude_patterns TEXT`);
    }

    const fks = db.pragma('foreign_key_list(references_table)') as Array<{ from: string; on_delete: string }>;
    const symFk = fks.find(f => f.from === 'symbol_id');
    if (symFk && symFk.on_delete !== 'SET NULL') {
      db.exec(`
        CREATE TABLE references_table_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          symbol_name TEXT NOT NULL,
          line_number INTEGER,
          column_number INTEGER,
          context TEXT
        );
        INSERT INTO references_table_new SELECT id, symbol_id, file_id, symbol_name, line_number, column_number, context FROM references_table;
        DROP TABLE references_table;
        ALTER TABLE references_table_new RENAME TO references_table;
        CREATE INDEX IF NOT EXISTS idx_refs_symbol ON references_table(symbol_id);
        CREATE INDEX IF NOT EXISTS idx_refs_file ON references_table(file_id);
        CREATE INDEX IF NOT EXISTS idx_refs_name ON references_table(symbol_name);
      `);
    }
  })();

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  logger.info(`Database migrated to schema v${SCHEMA_VERSION}`);
}

// Prepared statements are cached by SQL text. Creating throw-away statements in hot loops
// churns native objects (and has crashed the process under GC on some Node versions).
const stmtCache = new Map<string, Database.Statement>();

export function prep(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

export function closeDb(): void {
  stmtCache.clear();
  if (_db) {
    _db.close();
    _db = null;
    logger.info('Database closed');
  }
}

export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}
