import { z } from 'zod';
import path from 'path';
import os from 'os';

export const ConfigSchema = z.object({
  dbPath: z.string().default(path.join(os.homedir(), '.ue-codegraph', 'index.db')),
  batchSize: z.number().default(100),
  maxResults: z.number().default(50),
  maxCallChainDepth: z.number().default(10),
  cacheSize: z.number().default(64), // MB
  mmapSize: z.number().default(256), // MB
  fileExtensions: z.array(z.string()).default(['.h', '.hpp', '.cpp', '.cc', '.cxx', '.inl']),
  excludePatterns: z.array(z.string()).default([
    '**/ThirdParty/**',
    '**/Intermediate/**',
    '**/Binaries/**',
    '**/Saved/**',
    '**/DerivedDataCache/**',
    '**/.git/**',
    '**/node_modules/**',
  ]),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = ConfigSchema.parse({});
  }
  return _config;
}

export function setConfig(overrides: Partial<Config>): Config {
  _config = ConfigSchema.parse(overrides);
  return _config;
}
