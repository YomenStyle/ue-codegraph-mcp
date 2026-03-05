import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findReferences, searchSymbols, searchCode } from '../graph/cross-reference.js';

export function registerSearchTools(server: McpServer): void {
  server.tool(
    'find_references',
    'Find all references to a symbol (class, function, variable) across the codebase.',
    {
      symbol_name: z.string().describe('Name of the symbol to find references for'),
      max_results: z.number().optional().default(50).describe('Maximum results'),
    },
    async ({ symbol_name, max_results }) => {
      try {
        const refs = findReferences(symbol_name, max_results);
        if (refs.length === 0) {
          return { content: [{ type: 'text' as const, text: `No references found for '${symbol_name}'` }] };
        }

        const lines = [`References to '${symbol_name}' (${refs.length} found):\n`];
        for (const r of refs) {
          lines.push(`  ${r.filePath}:${r.lineNumber}:${r.columnNumber}`);
          if (r.context) {
            lines.push(`    ${r.context}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'search_symbols',
    'Search for symbols using full-text search (FTS5). Supports fuzzy matching.',
    {
      query: z.string().describe('Search query (supports prefix matching)'),
      kind: z.enum([
        'class', 'struct', 'enum', 'function', 'method', 'field', 'variable', 'typedef',
      ]).optional().describe('Filter by symbol kind'),
      max_results: z.number().optional().default(50).describe('Maximum results'),
    },
    async ({ query, kind, max_results }) => {
      try {
        let results = searchSymbols(query, max_results);

        if (kind) {
          results = results.filter(r => r.kind === kind);
        }

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No symbols found matching '${query}'` }] };
        }

        const lines = [`Symbols matching '${query}' (${results.length} found):\n`];
        for (const r of results) {
          lines.push(`  ${r.kind} ${r.qualifiedName || r.name}`);
          if (r.signature) {
            lines.push(`    Signature: ${r.signature}`);
          }
          lines.push(`    ${r.filePath}:${r.lineNumber}`);
          lines.push('');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'search_code',
    'Search through indexed code using text pattern matching.',
    {
      pattern: z.string().describe('Text pattern to search for'),
      codebase_id: z.number().optional().default(1).describe('Codebase ID'),
      max_results: z.number().optional().default(50).describe('Maximum results'),
    },
    async ({ pattern, codebase_id, max_results }) => {
      try {
        const results = searchCode(pattern, codebase_id, max_results);

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No matches found for '${pattern}'` }] };
        }

        const lines = [`Code matches for '${pattern}' (${results.length} found):\n`];
        for (const r of results) {
          lines.push(`  ${r.filePath}:${r.lineNumber}`);
          lines.push(`    ${r.lineContent}`);
          lines.push('');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
