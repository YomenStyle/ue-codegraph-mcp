import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db/database.js';

export function registerMacroTools(server: McpServer): void {
  server.tool(
    'find_ue_macros',
    'Search for UE macros (UCLASS, UPROPERTY, UFUNCTION, etc.) with optional filtering by type and specifiers.',
    {
      macro_type: z.enum([
        'UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION', 'UINTERFACE',
      ]).optional().describe('Filter by macro type'),
      specifier: z.string().optional().describe('Filter by specifier (e.g., BlueprintCallable, EditAnywhere)'),
      codebase_id: z.number().optional().default(1).describe('Codebase ID'),
      max_results: z.number().optional().default(50).describe('Maximum results'),
    },
    async ({ macro_type, specifier, codebase_id, max_results }) => {
      try {
        const db = getDb();

        let query = `
          SELECT
            m.macro_type,
            s.name as symbol_name,
            s.kind as symbol_kind,
            f.absolute_path as file_path,
            m.line_number,
            m.raw_text,
            GROUP_CONCAT(ms.key || COALESCE('=' || ms.value, ''), ', ') as specifiers
          FROM ue_macros m
          JOIN files f ON m.file_id = f.id
          LEFT JOIN symbols s ON m.symbol_id = s.id
          LEFT JOIN ue_macro_specifiers ms ON ms.macro_id = m.id
          WHERE f.codebase_id = @codebaseId
        `;

        const params: Record<string, unknown> = { codebaseId: codebase_id, limit: max_results };

        if (macro_type) {
          query += ` AND m.macro_type = @macroType`;
          params.macroType = macro_type;
        }

        if (specifier) {
          query += ` AND m.id IN (SELECT macro_id FROM ue_macro_specifiers WHERE key = @specifier)`;
          params.specifier = specifier;
        }

        query += ` GROUP BY m.id ORDER BY f.absolute_path, m.line_number LIMIT @limit`;

        const results = db.prepare(query).all(params) as Array<{
          macro_type: string;
          symbol_name: string | null;
          symbol_kind: string | null;
          file_path: string;
          line_number: number;
          raw_text: string;
          specifiers: string | null;
        }>;

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No macros found matching criteria.' }] };
        }

        const lines = [`Found ${results.length} UE macros:\n`];
        for (const r of results) {
          lines.push(`${r.macro_type}(${r.specifiers || ''})`);
          if (r.symbol_name) {
            lines.push(`  Symbol: ${r.symbol_name} (${r.symbol_kind})`);
          }
          lines.push(`  File: ${r.file_path}:${r.line_number}`);
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
    'get_macro_specifiers',
    'Get all specifiers for a specific UE macro instance, including meta specifiers.',
    {
      symbol_name: z.string().describe('Name of the symbol the macro is attached to'),
      macro_type: z.enum([
        'UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION', 'UINTERFACE',
      ]).optional().describe('Filter by specific macro type'),
    },
    async ({ symbol_name, macro_type }) => {
      try {
        const db = getDb();

        let query = `
          SELECT
            m.id as macro_id,
            m.macro_type,
            m.line_number,
            m.raw_text,
            ms.key,
            ms.value,
            ms.is_meta
          FROM ue_macros m
          JOIN symbols s ON m.symbol_id = s.id
          LEFT JOIN ue_macro_specifiers ms ON ms.macro_id = m.id
          WHERE s.name = @symbolName
        `;

        const params: Record<string, unknown> = { symbolName: symbol_name };

        if (macro_type) {
          query += ` AND m.macro_type = @macroType`;
          params.macroType = macro_type;
        }

        query += ` ORDER BY m.line_number, ms.id`;

        const results = db.prepare(query).all(params) as Array<{
          macro_id: number;
          macro_type: string;
          line_number: number;
          raw_text: string;
          key: string | null;
          value: string | null;
          is_meta: number;
        }>;

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No UE macros found for symbol '${symbol_name}'` }] };
        }

        // Group by macro
        const macroMap = new Map<number, { type: string; line: number; specs: string[]; meta: string[] }>();
        for (const r of results) {
          if (!macroMap.has(r.macro_id)) {
            macroMap.set(r.macro_id, { type: r.macro_type, line: r.line_number, specs: [], meta: [] });
          }
          const entry = macroMap.get(r.macro_id)!;
          if (r.key) {
            const formatted = r.value ? `${r.key}=${r.value}` : r.key;
            if (r.is_meta) {
              entry.meta.push(formatted);
            } else {
              entry.specs.push(formatted);
            }
          }
        }

        const lines = [`UE macros for '${symbol_name}':\n`];
        for (const [, m] of macroMap) {
          lines.push(`${m.type} (line ${m.line}):`);
          if (m.specs.length > 0) {
            lines.push(`  Specifiers: ${m.specs.join(', ')}`);
          }
          if (m.meta.length > 0) {
            lines.push(`  Meta: ${m.meta.join(', ')}`);
          }
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
