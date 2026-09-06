import type { Replacement } from './ast.ts';
import { HeroError } from '../util/errors.ts';
import { silentLogger, type Logger } from '../util/logger.ts';

/**
 * The last step of a render: the substitutions a template declares, applied
 * across the finished document.
 *
 * Templates use these for typography. The Ork template writes three, turning
 * `1/2` into `½` and `1/4` into `¼`, which is why the rules engine produces
 * fractions in their ASCII form and leaves the conversion until here. Order
 * matters and is the template's: `\b1/2d(\d)\b` has to run before `\b1/2\b`.
 *
 * The patterns come out of a template file, so they are treated as input:
 * their length is capped, and shapes known to make a regular expression run
 * away are refused rather than compiled.
 */

/** Longer than any real typographic rule, and short enough to stay cheap. */
const MAX_PATTERN_LENGTH = 1000;

/**
 * A quantified group that is itself quantified — `(a+)+`, `(a*)*` — is the
 * classic shape whose matching time explodes on input that nearly matches.
 * JavaScript offers no way to time a match out, so such patterns are refused
 * before they are compiled.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/;

/** Java constructs with no JavaScript equivalent. */
const UNSUPPORTED: readonly { readonly pattern: RegExp; readonly description: string }[] = [
  { pattern: /\(\?>/, description: 'an atomic group "(?>...)"' },
  { pattern: /[*+?}]\+/, description: 'a possessive quantifier such as "a++"' },
  { pattern: /\\Q|\\E/, description: 'a literal-text block "\\Q...\\E"' },
  { pattern: /\\[AahRZzGX]/, description: 'a Java-only escape' },
];

export interface PostProcessOptions {
  readonly strict?: boolean;
  readonly logger?: Logger;
}

export function applyReplacements(
  document: string,
  replacements: readonly Replacement[],
  options: PostProcessOptions = {},
): string {
  const logger = options.logger ?? silentLogger;
  let result = document;

  for (const replacement of replacements) {
    try {
      result =
        replacement.kind === 'regex'
          ? applyRegex(result, replacement.pattern, replacement.replacement)
          : result.replaceAll(replacement.find, () => replacement.replacement);
    } catch (cause) {
      const what =
        replacement.kind === 'regex'
          ? `the pattern "${replacement.pattern}"`
          : `the text "${replacement.find}"`;
      const message =
        `This template's replacement rule on line ${replacement.line} could not be applied, ` +
        `because ${what} was not usable: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (options.strict !== false) {
        throw new HeroError(message, { cause });
      }
      logger.warn(`${message} Skipping it.`);
    }
  }

  return result;
}

function applyRegex(document: string, pattern: string, replacement: string): string {
  const expression = new RegExp(translatePattern(pattern), 'g');
  const target = translateReplacement(replacement);
  return document.replace(expression, target);
}

/**
 * Converts a Java regular expression to a JavaScript one.
 *
 * The two dialects agree on nearly everything a template needs — character
 * classes, groups, `\b`, `\d` — so this checks for the constructs that differ
 * and otherwise passes the pattern through.
 */
export function translatePattern(pattern: string): string {
  if (pattern.length === 0) {
    throw new Error('it is empty');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`it is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  for (const { pattern: unsupported, description } of UNSUPPORTED) {
    if (unsupported.test(pattern)) {
      throw new Error(`it uses ${description}, which JavaScript does not support`);
    }
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new Error('it repeats a group that already repeats, which can take unbounded time to match');
  }
  // Compiling here turns a malformed pattern into an error the caller can
  // report against the template line it came from.
  new RegExp(pattern);
  return pattern;
}

/**
 * Converts a Java replacement string to a JavaScript one.
 *
 * Both spell a captured group `$1`, but they differ elsewhere: JavaScript also
 * gives `$&`, `` $` ``, `$'` and `$$` meanings, while Java treats those as
 * ordinary text and writes a literal dollar as `\$`.
 */
export function translateReplacement(replacement: string): string {
  let result = '';
  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i] as string;
    if (char === '\\' && replacement[i + 1] === '$') {
      result += '$$';
      i++;
      continue;
    }
    if (char === '\\' && replacement[i + 1] === '\\') {
      result += '\\';
      i++;
      continue;
    }
    if (char !== '$') {
      result += char;
      continue;
    }
    const next = replacement[i + 1];
    // A group reference passes through; anything else JavaScript would read as
    // special is escaped so it stays literal, as Java has it.
    result += next !== undefined && (/[0-9]/.test(next) || next === '{') ? '$' : '$$';
  }
  return result;
}
