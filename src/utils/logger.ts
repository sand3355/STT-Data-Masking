type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getConfiguredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return (raw in LEVELS ? raw : 'info') as LogLevel;
}

function log(level: LogLevel, context: string, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[getConfiguredLevel()]) return;
  const ts = new Date().toISOString();
  const parts = [`[${ts}]`, `[${level.toUpperCase()}]`, `[${context}]`, message];
  if (meta !== undefined) parts.push(JSON.stringify(meta));
  console[level === 'debug' ? 'log' : level](...parts);
}

export function createLogger(context: string) {
  return {
    debug: (msg: string, meta?: unknown) => log('debug', context, msg, meta),
    info: (msg: string, meta?: unknown) => log('info', context, msg, meta),
    warn: (msg: string, meta?: unknown) => log('warn', context, msg, meta),
    error: (msg: string, meta?: unknown) => log('error', context, msg, meta),
  };
}
