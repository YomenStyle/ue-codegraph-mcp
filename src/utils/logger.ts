export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
  if (level < currentLevel) return;
  const ts = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${ts}] ${prefix} ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${ts}] ${prefix} ${message}`;
  process.stderr.write(formatted + '\n');
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => log(LogLevel.DEBUG, '[DEBUG]', msg, ...args),
  info: (msg: string, ...args: unknown[]) => log(LogLevel.INFO, '[INFO]', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log(LogLevel.WARN, '[WARN]', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log(LogLevel.ERROR, '[ERROR]', msg, ...args),
};
