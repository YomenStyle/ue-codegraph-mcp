import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SCHEMA_DDL } from './schema.js';
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
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
}

function initSchema(db: Database.Database): void {
  db.exec(SCHEMA_DDL);
  logger.info('Schema initialized');
}

export function closeDb(): void {
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
