import { getDb } from '../db/database.js';

export interface ClassHierarchyNode {
  name: string;
  symbolId: number | null;
  filePath: string | null;
  lineNumber: number | null;
  access: string | null;
  depth: number;
}

export type HierarchyDirection = 'ancestors' | 'descendants' | 'both';

export function getClassHierarchy(
  className: string,
  direction: HierarchyDirection = 'both',
  maxDepth = 20,
): { ancestors: ClassHierarchyNode[]; descendants: ClassHierarchyNode[] } {
  const ancestors: ClassHierarchyNode[] = [];
  const descendants: ClassHierarchyNode[] = [];

  if (direction === 'ancestors' || direction === 'both') {
    ancestors.push(...findAncestors(className, maxDepth));
  }

  if (direction === 'descendants' || direction === 'both') {
    descendants.push(...findDescendants(className, maxDepth));
  }

  return { ancestors, descendants };
}

function findAncestors(className: string, maxDepth: number): ClassHierarchyNode[] {
  const db = getDb();
  return db.prepare(`
    WITH RECURSIVE ancestor_chain(depth, name, symbol_id, file_path, line_number, access, visited) AS (
      -- Base case: direct parents
      SELECT
        1,
        i.parent_name,
        i.parent_symbol_id,
        f.absolute_path,
        ps.line_start,
        i.access,
        '|' || @className || '|' || i.parent_name || '|'
      FROM inheritance i
      LEFT JOIN symbols ps ON i.parent_symbol_id = ps.id
      LEFT JOIN files f ON ps.file_id = f.id
      WHERE i.child_name = @className
         OR i.child_symbol_id IN (SELECT id FROM symbols WHERE name = @className)

      UNION ALL

      -- Recursive case: parent's parents
      SELECT
        ac.depth + 1,
        i.parent_name,
        i.parent_symbol_id,
        f.absolute_path,
        ps.line_start,
        i.access,
        ac.visited || i.parent_name || '|'
      FROM ancestor_chain ac
      JOIN inheritance i ON (i.child_name = ac.name
        OR i.child_symbol_id IN (SELECT id FROM symbols WHERE name = ac.name))
      LEFT JOIN symbols ps ON i.parent_symbol_id = ps.id
      LEFT JOIN files f ON ps.file_id = f.id
      WHERE ac.depth < @maxDepth
        AND ac.visited NOT LIKE '%|' || i.parent_name || '|%'
    )
    SELECT depth, name, symbol_id as symbolId, file_path as filePath,
           line_number as lineNumber, access
    FROM ancestor_chain
    ORDER BY depth
  `).all({ className, maxDepth }) as ClassHierarchyNode[];
}

function findDescendants(className: string, maxDepth: number): ClassHierarchyNode[] {
  const db = getDb();
  return db.prepare(`
    WITH RECURSIVE descendant_chain(depth, name, symbol_id, file_path, line_number, access, visited) AS (
      -- Base case: direct children
      SELECT
        1,
        COALESCE(cs.name, i.child_name),
        i.child_symbol_id,
        f.absolute_path,
        cs.line_start,
        i.access,
        '|' || @className || '|' || COALESCE(cs.name, i.child_name) || '|'
      FROM inheritance i
      LEFT JOIN symbols cs ON i.child_symbol_id = cs.id
      LEFT JOIN files f ON cs.file_id = f.id
      WHERE i.parent_name = @className
         OR i.parent_symbol_id IN (SELECT id FROM symbols WHERE name = @className)

      UNION ALL

      -- Recursive case: children's children
      SELECT
        dc.depth + 1,
        COALESCE(cs.name, i.child_name),
        i.child_symbol_id,
        f.absolute_path,
        cs.line_start,
        i.access,
        dc.visited || COALESCE(cs.name, i.child_name) || '|'
      FROM descendant_chain dc
      JOIN inheritance i ON (i.parent_name = dc.name
        OR i.parent_symbol_id IN (SELECT id FROM symbols WHERE name = dc.name))
      LEFT JOIN symbols cs ON i.child_symbol_id = cs.id
      LEFT JOIN files f ON cs.file_id = f.id
      WHERE dc.depth < @maxDepth
        AND dc.visited NOT LIKE '%|' || COALESCE(cs.name, i.child_name) || '|%'
    )
    SELECT depth, name, symbol_id as symbolId, file_path as filePath,
           line_number as lineNumber, access
    FROM descendant_chain
    ORDER BY depth
  `).all({ className, maxDepth }) as ClassHierarchyNode[];
}
