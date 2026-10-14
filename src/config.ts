import { z } from 'zod';
import path from 'path';
import os from 'os';

function defaultWorkers(): number {
  const env = process.env.UE_CODEGRAPH_WORKERS;
  if (env !== undefined && !Number.isNaN(Number(env))) return Math.max(0, Number(env));
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, cpus - 1));
}

export const ConfigSchema = z.object({
  dbPath: z.string().default(process.env.UE_CODEGRAPH_DB || path.join(os.homedir(), '.ue-codegraph', 'index.db')),
  batchSize: z.number().default(100),
  maxResults: z.number().default(50),
  maxCallChainDepth: z.number().default(10),
  cacheSize: z.number().default(64), // MB
  mmapSize: z.number().default(256), // MB
  // Parallel parsing: worker_threads count (0/1 = parse inline on the main thread)
  workers: z.number().default(defaultWorkers()),
  // Below this many files a batch is parsed inline (worker start-up costs more than it saves)
  parallelThreshold: z.number().default(24),
  // Auto-watch registered codebases while the MCP server runs
  watch: z.boolean().default(process.env.UE_CODEGRAPH_WATCH !== '0'),
  watchDebounceMs: z.number().default(400),
  // Above this share of changed files an incremental run falls back to full resolution
  fullResolveRatio: z.number().default(0.3),
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
