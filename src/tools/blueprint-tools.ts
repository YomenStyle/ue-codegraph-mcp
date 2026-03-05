import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findBlueprintExposed, getBlueprintInterface } from '../ue/blueprint-analyzer.js';

export function registerBlueprintTools(server: McpServer): void {
  server.tool(
    'find_blueprint_exposed',
    'Find all Blueprint-exposed functions and properties across the codebase.',
    {
      codebase_id: z.number().optional().default(1).describe('Codebase ID'),
      macro_type: z.enum(['UFUNCTION', 'UPROPERTY']).optional().describe('Filter by macro type'),
      max_results: z.number().optional().default(100).describe('Maximum results'),
    },
    async ({ codebase_id, macro_type, max_results }) => {
      try {
        const results = findBlueprintExposed(codebase_id, macro_type, max_results);

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No Blueprint-exposed items found.' }] };
        }

        const lines = [`Blueprint-exposed items (${results.length}):\n`];
        for (const r of results) {
          lines.push(`${r.macroType} ${r.symbolName || '(unnamed)'} [${r.specifiers.join(', ')}]`);
          lines.push(`  Kind: ${r.symbolKind || 'unknown'}`);
          lines.push(`  File: ${r.filePath}:${r.lineNumber}`);
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
    'get_blueprint_interface',
    'Get the complete Blueprint interface for a class (all BP-exposed functions, properties, events, delegates).',
    {
      class_name: z.string().describe('Name of the class to analyze'),
    },
    async ({ class_name }) => {
      try {
        const iface = getBlueprintInterface(class_name);

        if (!iface.filePath) {
          return { content: [{ type: 'text' as const, text: `Class '${class_name}' not found` }], isError: true };
        }

        const lines = [`# Blueprint Interface: ${class_name}\n`];
        lines.push(`File: ${iface.filePath}`);
        lines.push(`Blueprintable: ${iface.isBlueprintable ? 'Yes' : 'No'}`);
        lines.push(`BlueprintType: ${iface.isBlueprintType ? 'Yes' : 'No'}`);
        lines.push('');

        if (iface.functions.length > 0) {
          lines.push(`## Blueprint Functions (${iface.functions.length})`);
          for (const f of iface.functions) {
            lines.push(`  ${f.symbolName} [${f.specifiers.join(', ')}]`);
            lines.push(`    ${f.filePath}:${f.lineNumber}`);
          }
          lines.push('');
        }

        if (iface.properties.length > 0) {
          lines.push(`## Blueprint Properties (${iface.properties.length})`);
          for (const p of iface.properties) {
            lines.push(`  ${p.symbolName} [${p.specifiers.join(', ')}]`);
            lines.push(`    ${p.filePath}:${p.lineNumber}`);
          }
          lines.push('');
        }

        if (iface.events.length > 0) {
          lines.push(`## Blueprint Events (${iface.events.length})`);
          for (const e of iface.events) {
            lines.push(`  ${e.symbolName} [${e.specifiers.join(', ')}]`);
            lines.push(`    ${e.filePath}:${e.lineNumber}`);
          }
          lines.push('');
        }

        if (iface.delegates.length > 0) {
          lines.push(`## Delegates (${iface.delegates.length})`);
          for (const d of iface.delegates) {
            lines.push(`  ${d.symbolName} [${d.specifiers.join(', ')}]`);
            lines.push(`    ${d.filePath}:${d.lineNumber}`);
          }
        }

        if (iface.functions.length === 0 && iface.properties.length === 0 &&
            iface.events.length === 0 && iface.delegates.length === 0) {
          lines.push('No Blueprint-exposed members found.');
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
