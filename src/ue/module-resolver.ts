import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

export interface UEModule {
  name: string;
  path: string;
  type: 'Runtime' | 'Editor' | 'Developer' | 'ThirdParty' | 'Unknown';
  buildFile: string | null;
}

/**
 * Detect UE modules in a codebase by looking for .Build.cs or .uproject files
 */
export function detectModules(rootPath: string): UEModule[] {
  const modules: UEModule[] = [];

  function walk(dir: string, depth = 0): void {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.Build.cs')) {
        const moduleName = entry.name.replace('.Build.cs', '');
        const moduleType = detectModuleType(dir);
        modules.push({
          name: moduleName,
          path: dir,
          type: moduleType,
          buildFile: fullPath,
        });
      }

      if (entry.isDirectory() && !entry.name.startsWith('.') &&
          !['Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'node_modules'].includes(entry.name)) {
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(rootPath);
  logger.info(`Detected ${modules.length} UE modules`);
  return modules;
}

function detectModuleType(modulePath: string): UEModule['type'] {
  const normalized = modulePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/editor/')) return 'Editor';
  if (normalized.includes('/developer/')) return 'Developer';
  if (normalized.includes('/thirdparty/')) return 'ThirdParty';
  if (normalized.includes('/runtime/') || normalized.includes('/source/')) return 'Runtime';
  return 'Unknown';
}

/**
 * Detect if a path is a UE Engine source directory
 */
export function isEngineSource(rootPath: string): boolean {
  const indicators = [
    'Engine/Source/Runtime/Core',
    'Engine/Source/Runtime/Engine',
    'Engine/Source/Editor',
  ];
  return indicators.some(ind => fs.existsSync(path.join(rootPath, ind)));
}

/**
 * Detect if a path is a UE project directory
 */
export function isProjectDirectory(rootPath: string): boolean {
  const entries = fs.readdirSync(rootPath);
  return entries.some(e => e.endsWith('.uproject'));
}
