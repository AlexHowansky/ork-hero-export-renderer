/**
 * Errors and logging, free of Node APIs.
 *
 * `entrypoint.ts` and `version.ts` are absent: one inspects `process.argv` to
 * decide whether a module was run directly, the other reads `package.json` off
 * disk. Both are only meaningful for the CLIs.
 */

export { HeroError, InvalidFileError, RulesError } from './errors.ts';
export { consoleLogger, silentLogger, type Logger, type LogLevel } from './logger.ts';
