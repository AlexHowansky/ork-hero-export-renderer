/**
 * All errors this library throws are HeroError, and every message is written to
 * be read by a person who is not a programmer: what went wrong, in which file,
 * and where.
 */
export class HeroError extends Error {
  readonly source: string | undefined;
  readonly line: number | undefined;

  constructor(message: string, options: { source?: string; line?: number; cause?: unknown } = {}) {
    super(HeroError.decorate(message, options.source, options.line), { cause: options.cause });
    this.name = 'HeroError';
    this.source = options.source;
    this.line = options.line;
  }

  private static decorate(message: string, source?: string, line?: number): string {
    if (source === undefined) {
      return message;
    }
    return line === undefined ? `${message} (in ${source})` : `${message} (in ${source}, line ${line})`;
  }
}

/** Thrown when an input file is not the kind of file we were told it was. */
export class InvalidFileError extends HeroError {
  constructor(message: string, options: { source?: string; line?: number; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'InvalidFileError';
  }
}

/** Thrown when a file's content is structurally valid but semantically unusable. */
export class RulesError extends HeroError {
  constructor(message: string, options: { source?: string; line?: number; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'RulesError';
  }
}
