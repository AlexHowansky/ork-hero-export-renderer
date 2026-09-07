import { HeroError } from '../util/errors.ts';
import type { Logger } from '../util/logger.ts';

/**
 * Evaluates a `<!--MATH-->` block.
 *
 * The block's inner tags are substituted first, leaving an arithmetic
 * expression to work out — templates use it for things like a per-item share of
 * a total. Only numbers, the four operators, exponentiation and brackets are
 * allowed; the expression is parsed here rather than handed to anything that
 * could execute it.
 */
/**
 * Anything that is not part of an expression is dropped before it is read. The
 * equipment table divides one money figure by another to get a quantity, and
 * those figures carry their currency: `$100/$100` is one item, not a syntax
 * error.
 */
const NOT_ARITHMETIC = /[^-0-9.+*/^()\s]/g;

export function evaluateMath(expression: string, options: { strict: boolean; logger: Logger }): string {
  const source = expression.replace(NOT_ARITHMETIC, '').trim();
  try {
    const parser = new Parser(source);
    const value = parser.parseExpression();
    parser.expectEnd();
    return formatResult(value);
  } catch (error) {
    const message = `Could not work out the calculation "${expression.trim()}" in a <!--MATH--> block.`;
    if (options.strict) {
      throw new HeroError(message, { cause: error });
    }
    options.logger.warn(`${message} Leaving it blank.`);
    return '';
  }
}

function formatResult(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('the result is not a number');
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

class Parser {
  private pos = 0;

  constructor(private readonly input: string) {}

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const operator = this.peekOperator('+-');
      if (operator === undefined) {
        return value;
      }
      const right = this.parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    for (;;) {
      const operator = this.peekOperator('*/');
      if (operator === undefined) {
        return value;
      }
      const right = this.parseFactor();
      value = operator === '*' ? value * right : value / right;
    }
  }

  private parseFactor(): number {
    const base = this.parseUnary();
    if (this.peekOperator('^') === undefined) {
      return base;
    }
    return base ** this.parseFactor();
  }

  private parseUnary(): number {
    this.skipSpace();
    if (this.input[this.pos] === '-') {
      this.pos++;
      return -this.parseUnary();
    }
    if (this.input[this.pos] === '+') {
      this.pos++;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipSpace();
    if (this.input[this.pos] === '(') {
      this.pos++;
      const value = this.parseExpression();
      this.skipSpace();
      if (this.input[this.pos] !== ')') {
        throw new Error('a bracket is not closed');
      }
      this.pos++;
      return value;
    }
    const match = /^\d+(\.\d+)?/.exec(this.input.slice(this.pos));
    if (match === null) {
      throw new Error(`unexpected character at position ${this.pos}`);
    }
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private peekOperator(operators: string): string | undefined {
    this.skipSpace();
    const char = this.input[this.pos];
    if (char !== undefined && operators.includes(char)) {
      this.pos++;
      return char;
    }
    return undefined;
  }

  private skipSpace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos] as string)) {
      this.pos++;
    }
  }

  expectEnd(): void {
    this.skipSpace();
    if (this.pos !== this.input.length) {
      throw new Error(`unexpected text at position ${this.pos}`);
    }
  }
}
