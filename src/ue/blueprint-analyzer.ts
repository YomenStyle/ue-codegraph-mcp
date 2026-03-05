import { getDb } from '../db/database.js';
import { isBlueprintExposed, UESpecifier } from './macro-types.js';

export interface BlueprintExposedItem {
  symbolName: string;
  symbolKind: string;
  macroType: string;
  specifiers: string[];
  filePath: string;
  lineNumber: number;
}

export interface BlueprintInterface {
  className: string;
  filePath: string;
  isBlueprintable: boolean;
  isBlueprintType: boolean;
  functions: BlueprintExposedItem[];
  properties: BlueprintExposedItem[];
  events: BlueprintExposedItem[];
  delegates: BlueprintExposedItem[];
}

export function findBlueprintExposed(codebaseId: number, macroType?: string, maxResults = 100): BlueprintExposedItem[] {
  const db = getDb();

  let query = `
    SELECT
      s.name as symbolName,
      s.kind as symbolKind,
      m.macro_type as macroType,
      GROUP_CONCAT(ms.key || COALESCE('=' || ms.value, ''), '|') as specifiersStr,
      f.absolute_path as filePath,
      COALESCE(s.line_start, m.line_number) as lineNumber
    FROM ue_macros m
    JOIN files f ON m.file_id = f.id
    JOIN ue_macro_specifiers ms ON ms.macro_id = m.id
    LEFT JOIN symbols s ON m.symbol_id = s.id
    WHERE f.codebase_id = @codebaseId
      AND ms.key IN (
        'BlueprintCallable', 'BlueprintPure', 'BlueprintReadWrite',
        'BlueprintReadOnly', 'BlueprintImplementableEvent',
        'BlueprintNativeEvent', 'BlueprintAssignable',
        'BlueprintGetter', 'BlueprintSetter', 'Blueprintable', 'BlueprintType'
      )
  `;

  if (macroType) {
    query += ` AND m.macro_type = @macroType`;
  }

  query += `
    GROUP BY m.id
    ORDER BY f.absolute_path, m.line_number
    LIMIT @limit
  `;

  const results = db.prepare(query).all({
    codebaseId,
    macroType: macroType || null,
    limit: maxResults,
  }) as Array<BlueprintExposedItem & { specifiersStr: string }>;

  return results.map(r => ({
    ...r,
    specifiers: r.specifiersStr ? r.specifiersStr.split('|') : [],
  }));
}

export function getBlueprintInterface(className: string): BlueprintInterface {
  const db = getDb();

  // Find class symbol
  const classSymbol = db.prepare(`
    SELECT s.id, s.name, f.absolute_path as filePath
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.name = ? AND s.kind IN ('class', 'struct')
    LIMIT 1
  `).get(className) as { id: number; name: string; filePath: string } | undefined;

  if (!classSymbol) {
    return {
      className,
      filePath: '',
      isBlueprintable: false,
      isBlueprintType: false,
      functions: [],
      properties: [],
      events: [],
      delegates: [],
    };
  }

  // Check UCLASS specifiers - search by symbol_id or by any symbol with this class name
  const classMacro = db.prepare(`
    SELECT m.id, GROUP_CONCAT(ms.key, ',') as keys
    FROM ue_macros m
    LEFT JOIN ue_macro_specifiers ms ON ms.macro_id = m.id
    WHERE m.macro_type IN ('UCLASS', 'USTRUCT')
      AND (m.symbol_id = ? OR m.symbol_id IN (SELECT id FROM symbols WHERE name = ?))
    GROUP BY m.id
  `).get(classSymbol.id, className) as { id: number; keys: string } | undefined;

  const classKeys = classMacro?.keys?.split(',') || [];
  const isBlueprintable = classKeys.includes('Blueprintable') || classKeys.includes('BlueprintType');
  const isBlueprintType = classKeys.includes('BlueprintType');

  // Get all members with their macros
  const members = db.prepare(`
    SELECT
      s.name as symbolName,
      s.kind as symbolKind,
      m.macro_type as macroType,
      GROUP_CONCAT(ms.key || COALESCE('=' || ms.value, ''), '|') as specifiersStr,
      f.absolute_path as filePath,
      COALESCE(s.line_start, m.line_number) as lineNumber
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    LEFT JOIN ue_macros m ON m.symbol_id = s.id
    LEFT JOIN ue_macro_specifiers ms ON ms.macro_id = m.id
    WHERE s.parent_symbol_id = ?
      AND m.id IS NOT NULL
    GROUP BY s.id, m.id
  `).all(classSymbol.id) as Array<{
    symbolName: string;
    symbolKind: string;
    macroType: string;
    specifiersStr: string | null;
    filePath: string;
    lineNumber: number;
  }>;

  const functions: BlueprintExposedItem[] = [];
  const properties: BlueprintExposedItem[] = [];
  const events: BlueprintExposedItem[] = [];
  const delegates: BlueprintExposedItem[] = [];

  for (const m of members) {
    const specifiers = m.specifiersStr ? m.specifiersStr.split('|') : [];
    const item: BlueprintExposedItem = {
      symbolName: m.symbolName,
      symbolKind: m.symbolKind,
      macroType: m.macroType,
      specifiers,
      filePath: m.filePath,
      lineNumber: m.lineNumber,
    };

    const hasBP = specifiers.some(s =>
      s.startsWith('Blueprint') || s === 'Blueprintable' || s === 'BlueprintType'
    );

    if (!hasBP) continue;

    if (m.macroType === 'UFUNCTION') {
      if (specifiers.some(s => s.includes('ImplementableEvent') || s.includes('NativeEvent'))) {
        events.push(item);
      } else {
        functions.push(item);
      }
    } else if (m.macroType === 'UPROPERTY') {
      properties.push(item);
    } else if (m.macroType?.startsWith('DECLARE_')) {
      delegates.push(item);
    }
  }

  return {
    className,
    filePath: classSymbol.filePath,
    isBlueprintable,
    isBlueprintType,
    functions,
    properties,
    events,
    delegates,
  };
}
