/**
 * Splits a template into text and directives.
 *
 * A directive is an HTML comment whose entire body is an uppercase name,
 * optionally prefixed with `/` to close a container. Every other comment is
 * text: templates carry a human-readable banner comment at the top, and it has
 * to survive into the output untouched.
 */

const DIRECTIVE_BODY = /^\/?[A-Z0-9_]+$/;
const OPEN = '<!--';
const CLOSE = '-->';

export type Token = TextToken | DirectiveToken;

export interface TextToken {
  readonly kind: 'text';
  readonly text: string;
}

export interface DirectiveToken {
  readonly kind: 'directive';
  readonly name: string;
  readonly closing: boolean;
  /** The directive as written, needed when the renderer passes it through. */
  readonly raw: string;
  /** 1-based line of the directive, for error messages. */
  readonly line: number;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let textStart = 0;

  const countLines = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      if (source.charCodeAt(i) === 10) {
        line++;
      }
    }
  };

  const flushText = (until: number): void => {
    if (until > textStart) {
      tokens.push({ kind: 'text', text: source.slice(textStart, until) });
    }
  };

  while (pos < source.length) {
    const start = source.indexOf(OPEN, pos);
    if (start === -1) {
      break;
    }
    const end = source.indexOf(CLOSE, start + OPEN.length);
    if (end === -1) {
      // An unterminated comment is just text; the browser will treat it as
      // such, and refusing to render over it would help nobody.
      break;
    }

    const body = source.slice(start + OPEN.length, end);
    if (!DIRECTIVE_BODY.test(body)) {
      pos = end + CLOSE.length;
      continue;
    }

    flushText(start);
    countLines(textStart, start);
    tokens.push({
      kind: 'directive',
      name: body.startsWith('/') ? body.slice(1) : body,
      closing: body.startsWith('/'),
      raw: source.slice(start, end + CLOSE.length),
      line,
    });
    countLines(start, end + CLOSE.length);
    pos = end + CLOSE.length;
    textStart = pos;
  }

  flushText(source.length);
  return tokens;
}

/**
 * Names that appear as `<!--/NAME-->` somewhere in the template.
 *
 * Whether a directive opens a container or stands alone is decided by the
 * template itself rather than a fixed list, because the tag vocabulary is
 * partly generated — `<!--STR_VAL-->` and `<!--RUNNING_PRIMARY-->` are built
 * from a characteristic name and a suffix, not written down anywhere.
 */
export function findContainerNames(tokens: readonly Token[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const token of tokens) {
    if (token.kind === 'directive' && token.closing) {
      names.add(token.name);
    }
  }
  return names;
}
