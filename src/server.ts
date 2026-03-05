import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIndexTools } from './tools/index-tools.js';
import { registerGraphTools } from './tools/graph-tools.js';
import { registerClassTools } from './tools/class-tools.js';
import { registerMacroTools } from './tools/macro-tools.js';
import { registerBlueprintTools } from './tools/blueprint-tools.js';
import { registerSearchTools } from './tools/search-tools.js';
import { logger } from './utils/logger.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ue-codegraph',
    version: '1.0.0',
  });

  // Register all tool groups
  registerIndexTools(server);
  registerGraphTools(server);
  registerClassTools(server);
  registerMacroTools(server);
  registerBlueprintTools(server);
  registerSearchTools(server);

  logger.info('All 15 MCP tools registered');

  return server;
}
