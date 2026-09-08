/**
 * Errors and logging, free of Node APIs.
 *
 * `entrypoint.ts` is absent: it inspects `process.argv` to decide whether a
 * module was run directly, which is only meaningful for the CLIs.
 */

export { HeroError, InvalidFileError, RulesError } from './errors.ts';
export { consoleLogger, silentLogger, type Logger, type LogLevel } from './logger.ts';
