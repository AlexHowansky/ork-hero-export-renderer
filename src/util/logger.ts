export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Discards everything. The library default, so importing us is never noisy. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Writes to stderr, never stdout — the CLI streams the rendered document to
 * stdout, so anything else on that channel would corrupt the output.
 */
export function consoleLogger(minLevel: LogLevel = 'warn'): Logger {
  const threshold = LEVELS[minLevel];
  const emit = (level: LogLevel, message: string): void => {
    if (LEVELS[level] >= threshold) {
      process.stderr.write(`${level}: ${message}\n`);
    }
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}
