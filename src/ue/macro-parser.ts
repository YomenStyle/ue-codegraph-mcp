import { UESpecifier, META_SPECIFIERS } from './macro-types.js';

const metaSet = new Set(META_SPECIFIERS);

/**
 * Parse specifiers from UE macro content, e.g.:
 *   "BlueprintCallable, Category=\"Movement\", meta=(DisplayName=\"Foo\")"
 */
export function parseSpecifiers(content: string): { specifiers: UESpecifier[]; metaSpecifiers: UESpecifier[] } {
  const specifiers: UESpecifier[] = [];
  const metaSpecifiers: UESpecifier[] = [];

  if (!content || content.trim().length === 0) return { specifiers, metaSpecifiers };

  // Split top-level by commas (respecting parentheses and quotes)
  const tokens = splitTopLevel(content.trim());

  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    // Check for meta=(...)
    const metaMatch = trimmed.match(/^meta\s*=\s*\((.+)\)$/is);
    if (metaMatch) {
      const metaTokens = splitTopLevel(metaMatch[1]);
      for (const mt of metaTokens) {
        const parsed = parseKeyValue(mt.trim());
        if (parsed) {
          metaSpecifiers.push({ ...parsed, isMeta: true });
        }
      }
      continue;
    }

    const parsed = parseKeyValue(trimmed);
    if (parsed) {
      if (metaSet.has(parsed.key)) {
        metaSpecifiers.push({ ...parsed, isMeta: true });
      } else {
        specifiers.push({ ...parsed, isMeta: false });
      }
    }
  }

  return { specifiers, metaSpecifiers };
}

function parseKeyValue(token: string): { key: string; value: string | null } | null {
  if (!token) return null;

  const eqIdx = token.indexOf('=');
  if (eqIdx === -1) {
    return { key: token.trim(), value: null };
  }

  const key = token.substring(0, eqIdx).trim();
  let value = token.substring(eqIdx + 1).trim();

  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  // Remove surrounding parens for things like Category=(TopCategory|SubCategory)
  if (value.startsWith('(') && value.endsWith(')')) {
    value = value.slice(1, -1);
  }

  return { key, value: value || null };
}

function splitTopLevel(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      current += ch;
      if (ch === quoteChar && input[i - 1] !== '\\') {
        inQuote = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }

    if (ch === '(' || ch === '<') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === '>') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}
