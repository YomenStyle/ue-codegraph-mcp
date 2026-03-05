import Parser from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import fs from 'fs';
import { logger } from '../utils/logger.js';

let _parser: Parser | null = null;

function getParser(): Parser {
  if (!_parser) {
    _parser = new Parser();
    _parser.setLanguage(Cpp as unknown as Parser.Language);
  }
  return _parser;
}

export interface ParseResult {
  tree: Parser.Tree;
  source: string;       // preprocessed source (for AST)
  originalSource: string; // original source (for macro extraction)
}

/**
 * Preprocess UE C++ source to help tree-sitter parse correctly.
 * Strips API export macros, GENERATED_BODY(), and other UE-specific
 * constructs that confuse the parser.
 */
function preprocessUESource(source: string): string {
  let result = source;

  // Remove *_API export macros (e.g., MYPROJECT_API, ENGINE_API, CORE_API)
  result = result.replace(/\b[A-Z][A-Z0-9_]*_API\b/g, '');

  // Remove UE macro lines using balanced-paren aware replacement
  const macroNames = [
    'UCLASS', 'USTRUCT', 'UENUM', 'UINTERFACE',
    'UPROPERTY', 'UFUNCTION',
    'GENERATED_BODY', 'GENERATED_UCLASS_BODY',
  ];
  for (const name of macroNames) {
    result = stripMacroLines(result, name);
  }

  // Remove DECLARE_*_DELEGATE_* macros (multi-line aware)
  result = stripDelegateMacros(result);

  // Remove UMETA() in enum values (balanced parens)
  result = stripInlineMacro(result, 'UMETA');

  return result;
}

/**
 * Strip macro invocation lines from source, handling nested parentheses
 * and multi-line macros. Preserves line count by replacing with blank lines.
 */
function stripMacroLines(source: string, macroName: string): string {
  const lines = source.split('\n');
  const result: string[] = [];
  let inMacro = false;
  let depth = 0;

  for (const line of lines) {
    if (inMacro) {
      for (const ch of line) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }
      result.push(''); // blank line to preserve line numbers
      if (depth <= 0) {
        inMacro = false;
      }
    } else {
      const pattern = new RegExp(`^\\s*${macroName}\\s*\\(`);
      if (pattern.test(line)) {
        depth = 0;
        for (const ch of line) {
          if (ch === '(') depth++;
          if (ch === ')') depth--;
        }
        result.push(''); // blank line
        if (depth > 0) {
          inMacro = true; // multi-line: opening paren not yet closed
        }
      } else {
        result.push(line);
      }
    }
  }

  return result.join('\n');
}

/**
 * Strip DECLARE_*DELEGATE* and DECLARE_*EVENT* macros
 */
function stripDelegateMacros(source: string): string {
  const lines = source.split('\n');
  const result: string[] = [];
  let inMacro = false;
  let depth = 0;

  for (const line of lines) {
    if (inMacro) {
      for (const ch of line) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }
      result.push('');
      if (depth <= 0) inMacro = false;
    } else {
      if (/^\s*DECLARE_(?:DYNAMIC_)?(?:MULTICAST_)?(?:DELEGATE|EVENT)/.test(line)) {
        depth = 0;
        for (const ch of line) {
          if (ch === '(') depth++;
          if (ch === ')') depth--;
        }
        result.push('');
        if (depth > 0) inMacro = true;
      } else {
        result.push(line);
      }
    }
  }

  return result.join('\n');
}

/**
 * Strip inline macro calls like UMETA(...) within a line, handling nested parens
 */
function stripInlineMacro(source: string, macroName: string): string {
  const pattern = new RegExp(`${macroName}\\s*\\(`, 'g');
  let result = source;
  let match: RegExpExecArray | null;

  // Process from end to start to avoid offset shifts
  const matches: Array<{ start: number; end: number }> = [];
  while ((match = pattern.exec(result)) !== null) {
    const start = match.index;
    let depth = 0;
    let end = start;
    for (let i = match.index + match[0].length - 1; i < result.length; i++) {
      if (result[i] === '(') depth++;
      if (result[i] === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    matches.push({ start, end });
  }

  // Replace from end
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    result = result.substring(0, m.start) + result.substring(m.end);
  }

  return result;
}

export function parseFile(filePath: string): ParseResult | null {
  try {
    const originalSource = fs.readFileSync(filePath, 'utf-8');
    const source = preprocessUESource(originalSource);
    const parser = getParser();
    const tree = parser.parse(source);
    return { tree, source, originalSource };
  } catch (err) {
    logger.warn(`Failed to parse ${filePath}: ${err}`);
    return null;
  }
}

export function parseSource(source: string): Parser.Tree {
  const parser = getParser();
  const preprocessed = preprocessUESource(source);
  return parser.parse(preprocessed);
}

export { Parser };
