import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { indexCodebase, reindexSingleFile, IndexResult } from '../indexer/pipeline.js';
import { getDb } from '../db/database.js';
import { getQueries } from '../db/queries.js';
import { isEngineSource, isProjectDirectory } from '../ue/module-resolver.js';
import { watchCodebase, listWatched } from '../indexer/watcher.js';
import { getConfig } from '../config.js';
import path from 'path';
import { startViewer } from '../viewer/server.js';

export function registerIndexTools(server: McpServer): void {
  server.tool(
    'init_codebase',
    'Register and index a UE source or project codebase. Scans C++ files, extracts symbols, UE macros, call graphs, and include dependencies.',
    {
      path: z.string().describe('Absolute path to UE Engine source or project root'),
      name: z.string().optional().describe('Name for this codebase (defaults to directory name)'),
      type: z.enum(['engine', 'project']).optional().describe('Codebase type (auto-detected if not specified)'),
      headers_only: z.boolean().optional().default(false).describe('Only index header files (.h/.hpp/.inl), skip .cpp files. Recommended for large engine source to reduce index size.'),
    },
    async ({ path: rootPath, name, type, headers_only }) => {
      try {
        // Auto-detect type if not specified
        let codebaseType: 'engine' | 'project' = type || 'project';
        if (!type) {
          if (isEngineSource(rootPath)) {
            codebaseType = 'engine';
          } else if (isProjectDirectory(rootPath)) {
            codebaseType = 'project';
          }
        }

        const codebaseName = name || path.basename(path.resolve(rootPath)) || 'unnamed';

        const result = await indexCodebase(rootPath, codebaseName, codebaseType, headers_only ?? false);
        if (getConfig().watch) watchCodebase(rootPath, headers_only ?? false);

        return {
          content: [{
            type: 'text' as const,
            text: formatIndexResult(result),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error indexing codebase: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_index_status',
    'Get the indexing status and statistics for registered codebases.',
    {
      codebase_id: z.number().optional().describe('Specific codebase ID (shows all if omitted)'),
    },
    async ({ codebase_id }) => {
      try {
        const queries = getQueries();
        const db = getDb();

        if (codebase_id) {
          const codebase = queries.getCodebaseById.get({ id: codebase_id }) as Record<string, unknown> | undefined;
          if (!codebase) {
            return { content: [{ type: 'text' as const, text: 'Codebase not found' }], isError: true };
          }

          const fileCount = (queries.countFilesByCodebase.get({ codebaseId: codebase_id }) as { count: number }).count;
          const symbolCount = (queries.countSymbolsByCodebase.get({ codebaseId: codebase_id }) as { count: number }).count;
          const macroCount = (queries.countMacrosByCodebase.get({ codebaseId: codebase_id }) as { count: number }).count;

          return {
            content: [{
              type: 'text' as const,
              text: [
                `Codebase: ${codebase.name} (ID: ${codebase.id})`,
                `Type: ${codebase.type}`,
                `Path: ${codebase.root_path}`,
                `Last indexed: ${codebase.last_indexed_at || 'Never'}`,
                `Files: ${fileCount}`,
                `Symbols: ${symbolCount}`,
                `UE Macros: ${macroCount}`,
                `Watching: ${listWatched().includes(path.resolve(codebase.root_path as string)) ? 'yes (auto re-index on save)' : 'no'}`,
              ].join('\n'),
            }],
          };
        }

        // List all codebases
        const codebases = queries.listCodebases.all() as Array<Record<string, unknown>>;
        if (codebases.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No codebases registered. Use init_codebase to register and index a codebase.',
            }],
          };
        }

        const lines = ['Registered codebases:\n'];
        for (const cb of codebases) {
          const fileCount = (queries.countFilesByCodebase.get({ codebaseId: cb.id }) as { count: number }).count;
          const symbolCount = (queries.countSymbolsByCodebase.get({ codebaseId: cb.id }) as { count: number }).count;
          lines.push(`[${cb.id}] ${cb.name} (${cb.type})`);
          lines.push(`    Path: ${cb.root_path}`);
          lines.push(`    Files: ${fileCount}, Symbols: ${symbolCount}`);
          lines.push(`    Last indexed: ${cb.last_indexed_at || 'Never'}\n`);
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
    'open_viewer',
    'Start the local web viewer (class hierarchy, call graph, include graph, module map, index health) and return its URL. Tell the user to open the URL in a browser. The page refreshes by itself when the index changes.',
    {
      port: z.number().optional().describe('Preferred port (default 4177; next free port is used if taken)'),
    },
    async ({ port }) => {
      try {
        const viewer = await startViewer(port ?? 4177);
        return { content: [{ type: 'text' as const, text: `UE CodeGraph viewer is running: ${viewer.url}` }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error starting viewer: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'reindex_file',
    'Re-index specific files (normally unnecessary: changed files are picked up automatically by the file watcher). Deleted files are removed from the index. Only affected links are re-resolved.',
    {
      file_path: z.string().describe('Absolute path to the file to re-index'),
    },
    async ({ file_path }) => {
      try {
        const result = await reindexSingleFile(file_path);
        return {
          content: [{
            type: 'text' as const,
            text: result.message,
          }],
          isError: !result.success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

function formatIndexResult(result: IndexResult): string {
  return [
    `Indexing complete!`,
    `Codebase ID: ${result.codebaseId}`,
    `Total files: ${result.totalFiles}`,
    `  New: ${result.newFiles}`,
    `  Changed: ${result.changedFiles}`,
    `  Unchanged: ${result.unchangedFiles}`,
    `  Deleted: ${result.deletedFiles}`,
    `Symbols extracted: ${result.totalSymbols}`,
    `UE macros found: ${result.totalMacros}`,
    `Call relationships: ${result.totalCalls}`,
    `Include directives: ${result.totalIncludes}`,
    `Resolution: ${result.mode}${result.mode === 'incremental' ? ` (${result.relinkedFiles} files relinked)` : ''}`,
    `Time: ${(result.elapsedMs / 1000).toFixed(1)}s`,
  ].join('\n');
}
