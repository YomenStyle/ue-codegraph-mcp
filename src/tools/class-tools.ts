import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db/database.js';
import { getQueries } from '../db/queries.js';
import { getClassHierarchy, HierarchyDirection } from '../graph/inheritance-graph.js';
import { getUEPrefix, getUETypeDescription } from '../ue/naming-conventions.js';

export function registerClassTools(server: McpServer): void {
  server.tool(
    'analyze_class',
    'Get detailed analysis of a C++ class including methods, properties, UE macros, inheritance, and Blueprint exposure.',
    {
      class_name: z.string().describe('Name of the class to analyze'),
    },
    async ({ class_name }) => {
      try {
        const db = getDb();
        const queries = getQueries();

        // Find class symbol
        const classSymbols = queries.getSymbolsByName.all({ name: class_name }) as Array<{
          id: number;
          name: string;
          kind: string;
          file_path: string;
          line_start: number;
          line_end: number;
          qualified_name: string;
        }>;

        const classSymbol = classSymbols.find(s => s.kind === 'class' || s.kind === 'struct');
        if (!classSymbol) {
          return { content: [{ type: 'text' as const, text: `Class '${class_name}' not found` }], isError: true };
        }

        const lines: string[] = [];

        // Header info
        const uePrefix = getUEPrefix(class_name);
        lines.push(`# ${class_name}`);
        if (uePrefix !== 'None') {
          lines.push(`UE Type: ${getUETypeDescription(uePrefix)} (${uePrefix}* prefix)`);
        }
        lines.push(`Kind: ${classSymbol.kind}`);
        lines.push(`File: ${classSymbol.file_path}:${classSymbol.line_start}`);
        lines.push('');

        // Base classes
        const parents = queries.getParentClasses.all({ childSymbolId: classSymbol.id }) as Array<{
          parent_name: string;
          access: string;
          parent_class_name: string;
          file_path: string;
        }>;

        if (parents.length > 0) {
          lines.push('## Base Classes');
          for (const p of parents) {
            const loc = p.file_path ? ` (${p.file_path})` : '';
            lines.push(`  - ${p.access} ${p.parent_name}${loc}`);
          }
          lines.push('');
        }

        // UE Macros on class
        const classMacros = queries.getMacrosBySymbol.all({ symbolId: classSymbol.id }) as Array<{
          macro_type: string;
          specifiers_str: string;
          line_number: number;
        }>;

        if (classMacros.length > 0) {
          lines.push('## UE Macros');
          for (const m of classMacros) {
            lines.push(`  ${m.macro_type}(${m.specifiers_str || ''})`);
          }
          lines.push('');
        }

        // Members
        const members = queries.getSymbolsByParent.all({ parentId: classSymbol.id }) as Array<{
          id: number;
          name: string;
          kind: string;
          access: string;
          signature: string;
          is_virtual: number;
          is_static: number;
          return_type: string;
          line_start: number;
        }>;

        const methods = members.filter(m =>
          ['method', 'function', 'constructor', 'destructor'].includes(m.kind)
        );
        const fields = members.filter(m => m.kind === 'field');

        if (methods.length > 0) {
          lines.push(`## Methods (${methods.length})`);
          for (const m of methods) {
            const mods: string[] = [];
            if (m.access) mods.push(m.access);
            if (m.is_virtual) mods.push('virtual');
            if (m.is_static) mods.push('static');

            // Check for UE macro
            const macros = queries.getMacrosBySymbol.all({ symbolId: m.id }) as Array<{
              macro_type: string;
              specifiers_str: string;
            }>;

            let macroStr = '';
            if (macros.length > 0) {
              macroStr = ` [${macros.map(mc => `${mc.macro_type}(${mc.specifiers_str || ''})`).join(', ')}]`;
            }

            lines.push(`  ${mods.join(' ')} ${m.signature || m.name}${macroStr} :${m.line_start}`);
          }
          lines.push('');
        }

        if (fields.length > 0) {
          lines.push(`## Properties (${fields.length})`);
          for (const f of fields) {
            const macros = queries.getMacrosBySymbol.all({ symbolId: f.id }) as Array<{
              macro_type: string;
              specifiers_str: string;
            }>;

            let macroStr = '';
            if (macros.length > 0) {
              macroStr = ` [${macros.map(mc => `${mc.macro_type}(${mc.specifiers_str || ''})`).join(', ')}]`;
            }

            lines.push(`  ${f.access || ''} ${f.return_type || ''} ${f.name}${macroStr} :${f.line_start}`);
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
    'get_class_hierarchy',
    'Get the inheritance hierarchy for a class (ancestors, descendants, or both).',
    {
      class_name: z.string().describe('Name of the class'),
      direction: z.enum(['ancestors', 'descendants', 'both']).optional().default('both').describe('Direction to traverse'),
      max_depth: z.number().optional().default(20).describe('Maximum hierarchy depth'),
    },
    async ({ class_name, direction, max_depth }) => {
      try {
        const hierarchy = getClassHierarchy(class_name, direction as HierarchyDirection, max_depth);

        const lines = [`Class hierarchy for '${class_name}':\n`];

        if (hierarchy.ancestors.length > 0) {
          lines.push('Ancestors (base classes):');
          for (const a of hierarchy.ancestors) {
            const indent = '  '.repeat(a.depth);
            const loc = a.filePath ? ` (${a.filePath}:${a.lineNumber})` : '';
            lines.push(`${indent}${a.depth}. ${a.name}${loc}`);
          }
          lines.push('');
        }

        if (hierarchy.descendants.length > 0) {
          lines.push('Descendants (derived classes):');
          for (const d of hierarchy.descendants) {
            const indent = '  '.repeat(d.depth);
            const loc = d.filePath ? ` (${d.filePath}:${d.lineNumber})` : '';
            lines.push(`${indent}${d.depth}. ${d.name}${loc}`);
          }
        }

        if (hierarchy.ancestors.length === 0 && hierarchy.descendants.length === 0) {
          lines.push('No inheritance relationships found.');
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
