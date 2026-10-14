#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { closeDb } from './db/database.js';
import { logger } from './utils/logger.js';
import { startWatchingAll, stopAllWatchers } from './indexer/watcher.js';
import { shutdownParsePool } from './indexer/worker-pool.js';

async function main(): Promise<void> {
  logger.info('Starting UE CodeGraph MCP Server...');

  const server = createServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    stopAllWatchers();
    await shutdownParsePool();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await server.connect(transport);
  logger.info('UE CodeGraph MCP Server running on stdio');

  // Keep the index fresh without anyone calling reindex: catch up once, then watch for edits.
  startWatchingAll();
}

main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  closeDb();
  process.exit(1);
});
