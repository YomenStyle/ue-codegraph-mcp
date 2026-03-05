import Parser from 'tree-sitter';
import { ExtractedSymbol } from './symbol-extractor.js';

export interface ExtractedCall {
  callerName: string;
  calleeName: string;
  lineNumber: number;
}

export interface ExtractedInclude {
  path: string;
  isSystem: boolean;
  lineNumber: number;
}

export interface ExtractedReference {
  symbolName: string;
  lineNumber: number;
  columnNumber: number;
  context: string;
}

/**
 * Extract function call relationships from AST
 */
export function extractCalls(tree: Parser.Tree, source: string, symbols: ExtractedSymbol[]): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  const functionRanges = buildFunctionRanges(symbols);

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const calleeName = extractCalleeName(funcNode);
        if (calleeName && !isBuiltinOrMacro(calleeName)) {
          const line = node.startPosition.row + 1;
          const callerName = findEnclosingFunction(line, functionRanges);
          if (callerName) {
            calls.push({
              callerName,
              calleeName,
              lineNumber: line,
            });
          }
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return calls;
}

/**
 * Extract #include directives from source
 */
export function extractIncludes(source: string): ExtractedInclude[] {
  const includes: ExtractedInclude[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const systemMatch = line.match(/^#include\s*<([^>]+)>/);
    if (systemMatch) {
      includes.push({
        path: systemMatch[1],
        isSystem: true,
        lineNumber: i + 1,
      });
      continue;
    }
    const localMatch = line.match(/^#include\s*"([^"]+)"/);
    if (localMatch) {
      includes.push({
        path: localMatch[1],
        isSystem: false,
        lineNumber: i + 1,
      });
    }
  }

  return includes;
}

/**
 * Extract symbol references (identifiers) from AST for cross-referencing
 */
export function extractReferences(
  tree: Parser.Tree,
  source: string,
  knownSymbolNames: Set<string>,
): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const lines = source.split('\n');

  function visit(node: Parser.SyntaxNode): void {
    if (
      (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'field_identifier') &&
      knownSymbolNames.has(node.text)
    ) {
      const line = node.startPosition.row;
      refs.push({
        symbolName: node.text,
        lineNumber: line + 1,
        columnNumber: node.startPosition.column,
        context: lines[line]?.trim().substring(0, 200) || '',
      });
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return refs;
}

// --- Helpers ---

interface FunctionRange {
  name: string;
  qualifiedName: string;
  lineStart: number;
  lineEnd: number;
}

function buildFunctionRanges(symbols: ExtractedSymbol[]): FunctionRange[] {
  const ranges: FunctionRange[] = [];

  function collect(syms: ExtractedSymbol[]): void {
    for (const s of syms) {
      if (s.kind === 'function' || s.kind === 'method' || s.kind === 'constructor' || s.kind === 'destructor') {
        ranges.push({
          name: s.name,
          qualifiedName: s.qualifiedName || s.name,
          lineStart: s.lineStart,
          lineEnd: s.lineEnd,
        });
      }
      if (s.children.length > 0) {
        collect(s.children);
      }
    }
  }

  collect(symbols);
  return ranges;
}

function findEnclosingFunction(line: number, ranges: FunctionRange[]): string | null {
  for (const r of ranges) {
    if (line >= r.lineStart && line <= r.lineEnd) {
      return r.qualifiedName;
    }
  }
  return null;
}

function extractCalleeName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'identifier') {
    return node.text;
  }
  if (node.type === 'field_expression') {
    const field = node.childForFieldName('field');
    return field?.text || null;
  }
  if (node.type === 'qualified_identifier') {
    return node.text;
  }
  if (node.type === 'template_function') {
    const name = node.childForFieldName('name');
    return name?.text || null;
  }
  // Pointer-to-member calls, etc
  if (node.type === 'pointer_expression') {
    return extractCalleeName(node.children[1] || node);
  }
  return node.text || null;
}

const BUILTIN_MACROS = new Set([
  'check', 'ensure', 'verify', 'checkf', 'ensureMsgf', 'verifyf',
  'UE_LOG', 'UE_CLOG', 'CA_SUPPRESS',
  'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'offsetof', 'decltype',
  'TEXT', 'TEXTVIEW', 'LOCTEXT', 'NSLOCTEXT', 'INVTEXT',
  'GENERATED_BODY', 'GENERATED_UCLASS_BODY',
  'UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION', 'UINTERFACE',
  'UMETA',
]);

function isBuiltinOrMacro(name: string): boolean {
  if (BUILTIN_MACROS.has(name)) return true;
  // Skip all-caps macros (likely preprocessor macros)
  if (name === name.toUpperCase() && name.length > 2) return true;
  return false;
}
