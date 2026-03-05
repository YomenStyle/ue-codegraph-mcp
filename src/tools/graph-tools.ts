import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findCallers, findCallees, findCallChain } from '../graph/call-graph.js';
import { getFileDependencies, getTransitiveDependencies } from '../graph/dependency-graph.js';

export function registerGraphTools(server: McpServer): void {
  server.tool(
    'find_callers',
    'Find all functions that call a specific function.',
    {
      function_name: z.string().describe('Name of the function to find callers for'),
      max_results: z.number().optional().default(50).describe('Maximum results to return'),
    },
    async ({ function_name, max_results }) => {
      try {
        const callers = findCallers(function_name, max_results);
        if (callers.length === 0) {
          return { content: [{ type: 'text' as const, text: `No callers found for '${function_name}'` }] };
        }

        const lines = [`Callers of '${function_name}' (${callers.length} found):\n`];
        for (const c of callers) {
          lines.push(`  ${c.callerName}`);
          lines.push(`    ${c.filePath}:${c.lineNumber}`);
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
    'find_callees',
    'Find all functions called by a specific function.',
    {
      function_name: z.string().describe('Name of the function to find callees for'),
      max_results: z.number().optional().default(50).describe('Maximum results to return'),
    },
    async ({ function_name, max_results }) => {
      try {
        const callees = findCallees(function_name, max_results);
        if (callees.length === 0) {
          return { content: [{ type: 'text' as const, text: `No callees found for '${function_name}'` }] };
        }

        const lines = [`Functions called by '${function_name}' (${callees.length} found):\n`];
        for (const c of callees) {
          lines.push(`  ${c.calleeName}`);
          lines.push(`    ${c.filePath}:${c.lineNumber}`);
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
    'find_call_chain',
    'Find the shortest call chain from one function to another using recursive CTE graph traversal.',
    {
      from_function: z.string().describe('Starting function name'),
      to_function: z.string().describe('Target function name'),
      max_depth: z.number().optional().default(10).describe('Maximum chain depth'),
    },
    async ({ from_function, to_function, max_depth }) => {
      try {
        const chain = findCallChain(from_function, to_function, max_depth);
        if (chain.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No call chain found from '${from_function}' to '${to_function}' within depth ${max_depth}`,
            }],
          };
        }

        const lines = [`Call chain from '${from_function}' to '${to_function}':\n`];
        for (const step of chain) {
          lines.push(`  [${step.depth}] ${step.callerName} -> ${step.calleeName}`);
          lines.push(`       ${step.filePath}:${step.lineNumber}`);
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
    'get_file_dependencies',
    'Get #include dependency graph for a file (what it includes and what includes it).',
    {
      file_path: z.string().describe('Absolute path to the file'),
      include_transitive: z.boolean().optional().default(false).describe('Include transitive dependencies'),
      max_depth: z.number().optional().default(3).describe('Max depth for transitive dependencies'),
    },
    async ({ file_path, include_transitive, max_depth }) => {
      try {
        const deps = getFileDependencies(file_path);

        const lines = [`Dependencies for: ${file_path}\n`];

        lines.push(`Includes (${deps.includes.length}):`);
        for (const inc of deps.includes) {
          const resolved = inc.resolvedPath ? ` -> ${inc.resolvedPath}` : ' (unresolved)';
          lines.push(`  ${inc.isSystem ? '<' : '"'}${inc.includedPath}${inc.isSystem ? '>' : '"'}${resolved}`);
        }

        lines.push(`\nIncluded by (${deps.includedBy.length}):`);
        for (const inc of deps.includedBy) {
          lines.push(`  ${inc.filePath}:${inc.lineNumber}`);
        }

        if (include_transitive) {
          const transitive = getTransitiveDependencies(file_path, max_depth);
          lines.push(`\nTransitive dependencies (${transitive.length}):`);
          for (const dep of transitive) {
            lines.push(`  ${dep}`);
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
}
