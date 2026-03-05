#!/usr/bin/env node

import { createServer } from './build/server.js';
import { getDb, closeDb } from './build/db/database.js';
import { indexCodebase, reindexSingleFile } from './build/indexer/pipeline.js';
import { findCallers, findCallees, findCallChain } from './build/graph/call-graph.js';
import { getClassHierarchy } from './build/graph/inheritance-graph.js';
import { getFileDependencies } from './build/graph/dependency-graph.js';
import { findReferences, searchSymbols, searchCode } from './build/graph/cross-reference.js';
import { findBlueprintExposed, getBlueprintInterface } from './build/ue/blueprint-analyzer.js';
import { getQueries } from './build/db/queries.js';

const HELP = `
ue-graph - UE CodeGraph CLI

Usage:
  ue-graph <command> [arguments]

Commands:
  index <path> [name]           코드베이스 인덱싱
  status                        인덱싱 상태 조회
  reindex <file_path>           단일 파일 재인덱싱
  delete <id|name|all>          코드베이스 삭제

  analyze <class_name>          클래스 상세 분석
  hierarchy <class_name>        상속 계층 조회
  callers <function_name>       호출자 검색
  callees <function_name>       피호출자 검색
  chain <from> <to>             호출 체인 탐색

  macros [type] [specifier]     UE 매크로 검색
  blueprint [class_name]        Blueprint 노출 조회
  refs <symbol_name>            심볼 참조 검색
  search <query>                심볼 검색 (FTS)
  code <pattern>                코드 패턴 검색
  deps <file_path>              파일 의존성 조회

Examples:
  ue-graph index /mnt/g/UnrealEngine engine
  ue-graph analyze ACharacter
  ue-graph callers BeginPlay
  ue-graph chain BeginPlay Tick
  ue-graph macros UFUNCTION BlueprintCallable
  ue-graph blueprint ACharacter
  ue-graph search "Health"
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  // trim all args to handle Windows line endings
  const trimmedArgs = args.map(a => a.trim().replace(/\r/g, ''));
  const command = trimmedArgs[0];
  args.splice(0, args.length, ...trimmedArgs);

  try {
    switch (command) {
      case 'index': {
        const path = args[1];
        if (!path) { console.error('Error: path required\nUsage: ue-graph index <path> [name]'); process.exit(1); }
        const name = args[2] || path.split('/').pop();
        const type = args[3] === 'engine' ? 'engine' : 'project';
        console.log(`Indexing ${path} as "${name}" (${type})...`);
        const result = await indexCodebase(path, name, type);
        console.log(`\nDone!`);
        console.log(`  Files: ${result.totalFiles} (new: ${result.newFiles}, changed: ${result.changedFiles})`);
        console.log(`  Symbols: ${result.totalSymbols}`);
        console.log(`  UE Macros: ${result.totalMacros}`);
        console.log(`  Calls: ${result.totalCalls}`);
        console.log(`  Includes: ${result.totalIncludes}`);
        console.log(`  Time: ${(result.elapsedMs / 1000).toFixed(1)}s`);
        break;
      }

      case 'status': {
        const queries = getQueries();
        const codebases = queries.listCodebases.all();
        if (codebases.length === 0) {
          console.log('No codebases indexed. Run: ue-graph index <path>');
          break;
        }
        for (const cb of codebases) {
          const files = queries.countFilesByCodebase.get({ codebaseId: cb.id });
          const symbols = queries.countSymbolsByCodebase.get({ codebaseId: cb.id });
          const macros = queries.countMacrosByCodebase.get({ codebaseId: cb.id });
          console.log(`[${cb.id}] ${cb.name} (${cb.type})`);
          console.log(`    Path: ${cb.root_path}`);
          console.log(`    Files: ${files.count} | Symbols: ${symbols.count} | Macros: ${macros.count}`);
          console.log(`    Last indexed: ${cb.last_indexed_at || 'Never'}`);
        }
        break;
      }

      case 'delete': case 'remove': case 'rm': {
        const target = args[1];
        if (!target) { console.error('Usage: ue-graph delete <id|name|all>'); process.exit(1); }
        const db = getDb();

        if (target === 'all') {
          const codebases = db.prepare('SELECT id, name FROM codebases').all();
          if (codebases.length === 0) { console.log('No codebases to delete.'); break; }
          db.prepare('DELETE FROM codebases').run();
          console.log(`Deleted ${codebases.length} codebase(s):`);
          codebases.forEach(cb => console.log(`  [${cb.id}] ${cb.name}`));
        } else {
          const id = parseInt(target);
          let cb;
          if (!isNaN(id)) {
            cb = db.prepare('SELECT id, name FROM codebases WHERE id = ?').get(id);
          } else {
            cb = db.prepare('SELECT id, name FROM codebases WHERE name = ?').get(target);
          }
          if (!cb) { console.error(`Codebase '${target}' not found. Run: ue-graph status`); process.exit(1); }
          db.prepare('DELETE FROM codebases WHERE id = ?').run(cb.id);
          console.log(`Deleted: [${cb.id}] ${cb.name}`);
        }
        break;
      }

      case 'reindex': {
        const filePath = args[1];
        if (!filePath) { console.error('Usage: ue-graph reindex <file_path>'); process.exit(1); }
        const result = await reindexSingleFile(filePath);
        console.log(result.message);
        break;
      }

      case 'analyze': {
        const className = args[1];
        if (!className) { console.error('Usage: ue-graph analyze <class_name>'); process.exit(1); }
        const db = getDb();
        const queries = getQueries();

        const cls = queries.getSymbolsByName.all({ name: className }).find(s => s.kind === 'class' || s.kind === 'struct');
        if (!cls) { console.error(`Class '${className}' not found`); break; }

        console.log(`# ${className}`);
        console.log(`  Kind: ${cls.kind}`);
        console.log(`  File: ${cls.file_path}:${cls.line_start}`);

        // Parents
        const parents = queries.getParentClasses.all({ childSymbolId: cls.id });
        if (parents.length > 0) {
          console.log(`\n  Base classes:`);
          parents.forEach(p => console.log(`    ${p.access} ${p.parent_name}`));
        }

        // UE macros on class
        const macros = queries.getMacrosBySymbol.all({ symbolId: cls.id });
        if (macros.length > 0) {
          console.log(`\n  UE Macros:`);
          macros.forEach(m => console.log(`    ${m.macro_type}(${m.specifiers_str || ''})`));
        }

        // Members
        const members = queries.getSymbolsByParent.all({ parentId: cls.id });
        const methods = members.filter(m => ['method', 'function', 'constructor', 'destructor'].includes(m.kind));
        const fields = members.filter(m => m.kind === 'field');

        if (methods.length > 0) {
          console.log(`\n  Methods (${methods.length}):`);
          for (const m of methods) {
            const mods = [m.access, m.is_virtual ? 'virtual' : '', m.is_static ? 'static' : ''].filter(Boolean).join(' ');
            const mac = queries.getMacrosBySymbol.all({ symbolId: m.id });
            const macStr = mac.length > 0 ? ` [${mac.map(mc => mc.macro_type).join(', ')}]` : '';
            console.log(`    ${mods} ${m.signature || m.name}${macStr}`);
          }
        }

        if (fields.length > 0) {
          console.log(`\n  Properties (${fields.length}):`);
          for (const f of fields) {
            const mac = queries.getMacrosBySymbol.all({ symbolId: f.id });
            const macStr = mac.length > 0 ? ` [${mac.map(mc => mc.macro_type).join(', ')}]` : '';
            console.log(`    ${f.access || ''} ${f.return_type || ''} ${f.name}${macStr}`);
          }
        }
        break;
      }

      case 'hierarchy': {
        const className = args[1];
        if (!className) { console.error('Usage: ue-graph hierarchy <class_name>'); process.exit(1); }
        const dir = args[2] || 'both';
        const h = getClassHierarchy(className, dir);

        if (h.ancestors.length > 0) {
          console.log(`Ancestors:`);
          h.ancestors.forEach(a => console.log(`  ${'  '.repeat(a.depth)}${a.name}${a.filePath ? ` (${a.filePath}:${a.lineNumber})` : ''}`));
        }
        console.log(`\n> ${className}`);
        if (h.descendants.length > 0) {
          console.log(`\nDescendants:`);
          h.descendants.forEach(d => console.log(`  ${'  '.repeat(d.depth)}${d.name}${d.filePath ? ` (${d.filePath}:${d.lineNumber})` : ''}`));
        }
        if (h.ancestors.length === 0 && h.descendants.length === 0) {
          console.log('  No inheritance relationships found.');
        }
        break;
      }

      case 'callers': {
        const name = args[1];
        if (!name) { console.error('Usage: ue-graph callers <function_name>'); process.exit(1); }
        const max = parseInt(args[2]) || 50;
        const callers = findCallers(name, max);
        if (callers.length === 0) { console.log(`No callers found for '${name}'`); break; }
        console.log(`Callers of '${name}' (${callers.length}):`);
        callers.forEach(c => console.log(`  ${c.callerName}  ${c.filePath}:${c.lineNumber}`));
        break;
      }

      case 'callees': {
        const name = args[1];
        if (!name) { console.error('Usage: ue-graph callees <function_name>'); process.exit(1); }
        const max = parseInt(args[2]) || 50;
        const callees = findCallees(name, max);
        if (callees.length === 0) { console.log(`No callees found for '${name}'`); break; }
        console.log(`Functions called by '${name}' (${callees.length}):`);
        callees.forEach(c => console.log(`  -> ${c.calleeName}  ${c.filePath}:${c.lineNumber}`));
        break;
      }

      case 'chain': {
        const from = args[1], to = args[2];
        if (!from || !to) { console.error('Usage: ue-graph chain <from_function> <to_function>'); process.exit(1); }
        const depth = parseInt(args[3]) || 10;
        const chain = findCallChain(from, to, depth);
        if (chain.length === 0) { console.log(`No call chain found from '${from}' to '${to}'`); break; }
        console.log(`Call chain: ${from} -> ${to}`);
        chain.forEach(s => console.log(`  [${s.depth}] ${s.callerName} -> ${s.calleeName}  ${s.filePath}:${s.lineNumber}`));
        break;
      }

      case 'macros': {
        const macroType = args[1] || null;
        const specifier = args[2] || null;
        const db = getDb();
        let query = `
          SELECT m.macro_type, s.name as symbol_name, f.absolute_path as file_path, m.line_number,
                 GROUP_CONCAT(ms.key || COALESCE('=' || ms.value, ''), ', ') as specifiers
          FROM ue_macros m
          JOIN files f ON m.file_id = f.id
          LEFT JOIN symbols s ON m.symbol_id = s.id
          LEFT JOIN ue_macro_specifiers ms ON ms.macro_id = m.id
          WHERE 1=1
        `;
        const params = {};
        if (macroType) { query += ` AND m.macro_type = @macroType`; params.macroType = macroType; }
        if (specifier) { query += ` AND m.id IN (SELECT macro_id FROM ue_macro_specifiers WHERE key = @specifier)`; params.specifier = specifier; }
        query += ` GROUP BY m.id ORDER BY f.absolute_path, m.line_number LIMIT 100`;

        const results = db.prepare(query).all(params);
        if (results.length === 0) { console.log('No macros found.'); break; }
        console.log(`Found ${results.length} macros:`);
        results.forEach(r => {
          console.log(`  ${r.macro_type}(${r.specifiers || ''}) -> ${r.symbol_name || '?'}  ${r.file_path}:${r.line_number}`);
        });
        break;
      }

      case 'blueprint': case 'bp': {
        const className = args[1];
        if (className) {
          const iface = getBlueprintInterface(className);
          if (!iface.filePath) { console.error(`Class '${className}' not found`); break; }
          console.log(`# Blueprint Interface: ${className}`);
          console.log(`  Blueprintable: ${iface.isBlueprintable} | BlueprintType: ${iface.isBlueprintType}`);
          if (iface.functions.length) { console.log(`\n  Functions:`); iface.functions.forEach(f => console.log(`    ${f.symbolName} [${f.specifiers.join(', ')}]`)); }
          if (iface.properties.length) { console.log(`\n  Properties:`); iface.properties.forEach(p => console.log(`    ${p.symbolName} [${p.specifiers.join(', ')}]`)); }
          if (iface.events.length) { console.log(`\n  Events:`); iface.events.forEach(e => console.log(`    ${e.symbolName} [${e.specifiers.join(', ')}]`)); }
          if (iface.delegates.length) { console.log(`\n  Delegates:`); iface.delegates.forEach(d => console.log(`    ${d.symbolName} [${d.specifiers.join(', ')}]`)); }
        } else {
          const items = findBlueprintExposed(1);
          if (items.length === 0) { console.log('No Blueprint-exposed items found.'); break; }
          console.log(`Blueprint-exposed (${items.length}):`);
          items.forEach(b => console.log(`  ${b.macroType} ${b.symbolName || '?'} [${b.specifiers.join(', ')}]  ${b.filePath}:${b.lineNumber}`));
        }
        break;
      }

      case 'refs': {
        const name = args[1];
        if (!name) { console.error('Usage: ue-graph refs <symbol_name>'); process.exit(1); }
        const refs = findReferences(name, parseInt(args[2]) || 50);
        if (refs.length === 0) { console.log(`No references found for '${name}'`); break; }
        console.log(`References to '${name}' (${refs.length}):`);
        refs.forEach(r => console.log(`  ${r.filePath}:${r.lineNumber}:${r.columnNumber}  ${r.context || ''}`));
        break;
      }

      case 'search': {
        const query = args[1];
        if (!query) { console.error('Usage: ue-graph search <query>'); process.exit(1); }
        const results = searchSymbols(query, parseInt(args[2]) || 50);
        if (results.length === 0) { console.log(`No symbols found for '${query}'`); break; }
        console.log(`Symbols matching '${query}' (${results.length}):`);
        results.forEach(r => console.log(`  ${r.kind} ${r.qualifiedName || r.name}  ${r.filePath}:${r.lineNumber}`));
        break;
      }

      case 'code': {
        const pattern = args[1];
        if (!pattern) { console.error('Usage: ue-graph code <pattern>'); process.exit(1); }
        const results = searchCode(pattern, parseInt(args[2]) || 1, parseInt(args[3]) || 50);
        if (results.length === 0) { console.log(`No matches for '${pattern}'`); break; }
        console.log(`Code matches for '${pattern}' (${results.length}):`);
        results.forEach(r => console.log(`  ${r.filePath}:${r.lineNumber}  ${r.lineContent}`));
        break;
      }

      case 'deps': {
        const filePath = args[1];
        if (!filePath) { console.error('Usage: ue-graph deps <file_path>'); process.exit(1); }
        const deps = getFileDependencies(filePath);
        console.log(`Includes (${deps.includes.length}):`);
        deps.includes.forEach(i => console.log(`  ${i.includedPath}${i.resolvedPath ? ` -> ${i.resolvedPath}` : ' (unresolved)'}`));
        console.log(`\nIncluded by (${deps.includedBy.length}):`);
        deps.includedBy.forEach(i => console.log(`  ${i.filePath}:${i.lineNumber}`));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
