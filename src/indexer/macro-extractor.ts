import { UEMacro, UE_MACRO_TYPES, UEMacroType } from '../ue/macro-types.js';
import { parseSpecifiers } from '../ue/macro-parser.js';

// Regex patterns for UE macros
const MACRO_PATTERNS: Array<{ type: UEMacroType; pattern: RegExp }> = [
  { type: 'UCLASS', pattern: /^(\s*)UCLASS\s*\(([^)]*)\)/gm },
  { type: 'USTRUCT', pattern: /^(\s*)USTRUCT\s*\(([^)]*)\)/gm },
  { type: 'UENUM', pattern: /^(\s*)UENUM\s*\(([^)]*)\)/gm },
  { type: 'UPROPERTY', pattern: /^(\s*)UPROPERTY\s*\(([^)]*)\)/gm },
  { type: 'UFUNCTION', pattern: /^(\s*)UFUNCTION\s*\(([^)]*)\)/gm },
  { type: 'UINTERFACE', pattern: /^(\s*)UINTERFACE\s*\(([^)]*)\)/gm },
  { type: 'GENERATED_BODY', pattern: /^(\s*)GENERATED_BODY\s*\(\s*\)/gm },
  { type: 'GENERATED_UCLASS_BODY', pattern: /^(\s*)GENERATED_UCLASS_BODY\s*\(\s*\)/gm },
];

// Delegate macros - more complex patterns
const DELEGATE_PATTERN = /^(\s*)(DECLARE_(?:DYNAMIC_(?:MULTICAST_)?)?(?:DELEGATE|EVENT|MULTICAST_DELEGATE)[A-Za-z_]*)\s*\(([^)]*)\)/gm;

export function extractMacros(source: string): UEMacro[] {
  const macros: UEMacro[] = [];
  const lines = source.split('\n');

  // Extract standard UE macros
  for (const { type, pattern } of MACRO_PATTERNS) {
    // Reset regex
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source)) !== null) {
      const lineNumber = getLineNumber(source, match.index);
      const rawText = match[0].trim();
      const specContent = match[2] || '';

      const { specifiers, metaSpecifiers } = type === 'GENERATED_BODY' || type === 'GENERATED_UCLASS_BODY'
        ? { specifiers: [], metaSpecifiers: [] }
        : parseSpecifiers(specContent);

      macros.push({
        macroType: type,
        lineNumber,
        rawText,
        specifiers,
        metaSpecifiers,
      });
    }
  }

  // Extract delegate macros
  DELEGATE_PATTERN.lastIndex = 0;
  let delegateMatch: RegExpExecArray | null;
  while ((delegateMatch = DELEGATE_PATTERN.exec(source)) !== null) {
    const macroName = delegateMatch[2];
    const lineNumber = getLineNumber(source, delegateMatch.index);

    let macroType: UEMacroType = 'OTHER';
    if (macroName.includes('DYNAMIC_MULTICAST')) macroType = 'DECLARE_DYNAMIC_MULTICAST_DELEGATE';
    else if (macroName.includes('DYNAMIC_DELEGATE') || macroName.includes('DYNAMIC')) macroType = 'DECLARE_DYNAMIC_DELEGATE';
    else if (macroName.includes('MULTICAST')) macroType = 'DECLARE_MULTICAST_DELEGATE';
    else if (macroName.includes('DELEGATE')) macroType = 'DECLARE_DELEGATE';
    else if (macroName.includes('EVENT')) macroType = 'DECLARE_EVENT';

    macros.push({
      macroType,
      lineNumber,
      rawText: delegateMatch[0].trim(),
      specifiers: [],
      metaSpecifiers: [],
    });
  }

  // Also handle multi-line UPROPERTY/UFUNCTION (common in UE code)
  extractMultiLineMacros(source, macros);

  // De-duplicate by line number
  const seen = new Set<number>();
  const unique: UEMacro[] = [];
  // Sort by line for consistent order and prefer already-found (single-line) over multi-line
  macros.sort((a, b) => a.lineNumber - b.lineNumber);
  for (const m of macros) {
    if (!seen.has(m.lineNumber)) {
      seen.add(m.lineNumber);
      unique.push(m);
    }
  }

  return unique;
}

function extractMultiLineMacros(source: string, macros: UEMacro[]): void {
  const lines = source.split('\n');
  const existingLines = new Set(macros.map(m => m.lineNumber));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for UE macro start that isn't closed on same line
    for (const macroType of ['UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION', 'UINTERFACE'] as UEMacroType[]) {
      const startPattern = new RegExp(`^${macroType}\\s*\\(`);
      if (startPattern.test(line) && !line.includes(')')) {
        // Multi-line macro - collect until closing paren
        let fullText = line;
        let j = i + 1;
        let depth = 1;
        for (const ch of line) {
          if (ch === '(') depth++;
        }
        depth--; // the opening paren

        while (j < lines.length && depth > 0) {
          const nextLine = lines[j].trim();
          fullText += ' ' + nextLine;
          for (const ch of nextLine) {
            if (ch === '(') depth++;
            if (ch === ')') depth--;
          }
          j++;
        }

        const lineNumber = i + 1;
        if (!existingLines.has(lineNumber)) {
          const contentMatch = fullText.match(new RegExp(`${macroType}\\s*\\((.*)\\)`, 's'));
          const specContent = contentMatch ? contentMatch[1] : '';
          const { specifiers, metaSpecifiers } = parseSpecifiers(specContent);

          macros.push({
            macroType,
            lineNumber,
            rawText: fullText.substring(0, 500),
            specifiers,
            metaSpecifiers,
          });
        }
      }
    }
  }
}

function getLineNumber(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}
