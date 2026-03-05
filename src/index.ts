#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { closeDb } from './db/database.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('Starting UE CodeGraph MCP Server...');

  const server = createServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    closeDb();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    closeDb();
    process.exit(0);
  });

  await server.connect(transport);
  logger.info('UE CodeGraph MCP Server running on stdio');
}

main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  closeDb();
  process.exit(1);
});
