import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applyReplacements, translatePattern, translateReplacement } from '../src/template/postprocess.ts';
import { parseTemplate } from '../src/template/parser.ts';
import { HeroError } from '../src/util/errors.ts';
import { silentLogger } from '../src/util/logger.ts';
import type { Replacement } from '../src/template/ast.ts';

const regex = (pattern: string, replacement: string, line = 1): Replacement => ({
  kind: 'regex',
  pattern,
  replacement,
  line,
});

describe('applyReplacements', () => {
  test('applies a regular expression across the whole document', () => {
    expect(applyReplacements('a 1/2 b 1/2', [regex('\\b1/2\\b', '½')])).toBe('a ½ b ½');
  });

  test('supports captured groups', () => {
    expect(applyReplacements('3 1/2d6', [regex('\\b1/2d(\\d)\\b', '½d$1')])).toBe('3 ½d6');
  });

  // Each rule runs over what the one before it produced, so the template's
  // order is the order they are applied in.
  test('applies rules in the order the template declares them, chaining them', () => {
    const rules = [regex('a', 'b'), regex('b', 'c')];
    expect(applyReplacements('a', rules)).toBe('c');
    expect(applyReplacements('a', [...rules].reverse())).toBe('b');
  });

  test('applies a literal replacement everywhere without treating it as a pattern', () => {
    const literal: Replacement = { kind: 'literal', find: 'a.c', replacement: 'X', line: 1 };
    expect(applyReplacements('a.c abc', [literal])).toBe('X abc');
  });

  test('does not treat a dollar sign in literal replacement text as a group', () => {
    const literal: Replacement = { kind: 'literal', find: 'X', replacement: '$1', line: 1 };
    expect(applyReplacements('X', [literal])).toBe('$1');
  });

  test('names the template line when a rule cannot be applied', () => {
    expect(() => applyReplacements('x', [regex('(unclosed', 'y', 42)])).toThrow(HeroError);
    expect(() => applyReplacements('x', [regex('(unclosed', 'y', 42)])).toThrow(
      /replacement rule on line 42/,
    );
  });

  test('can be told to skip a bad rule instead of failing', () => {
    expect(
      applyReplacements('x', [regex('(unclosed', 'y')], { strict: false, logger: silentLogger }),
    ).toBe('x');
  });
});

describe('translatePattern', () => {
  test('passes through what both dialects share', () => {
    expect(translatePattern('\\b1/2d(\\d)\\b')).toBe('\\b1/2d(\\d)\\b');
  });

  // Patterns come out of a template file, so they are treated as input.
  test('refuses a pattern that could take unbounded time to match', () => {
    expect(() => translatePattern('(a+)+$')).toThrow(/unbounded time/);
  });

  test('refuses an over-long pattern', () => {
    expect(() => translatePattern('a'.repeat(1001))).toThrow(/longer than 1000 characters/);
  });

  test.each([
    ['(?>abc)', /atomic group/],
    ['a++', /possessive quantifier/],
    ['\\Qliteral\\E', /literal-text block/],
    ['\\A', /Java-only escape/],
  ])('refuses %p, which JavaScript cannot express', (pattern, message) => {
    expect(() => translatePattern(pattern)).toThrow(message);
  });

  test('refuses a malformed pattern', () => {
    expect(() => translatePattern('(')).toThrow();
    expect(() => translatePattern('')).toThrow(/it is empty/);
  });
});

describe('translateReplacement', () => {
  test('keeps group references', () => {
    expect(translateReplacement('½d$1')).toBe('½d$1');
    expect(translateReplacement('${name}')).toBe('${name}');
  });

  // Java gives these no special meaning, so they must survive as themselves.
  test('escapes what JavaScript alone treats as special', () => {
    expect(translateReplacement('$&')).toBe('$$&');
    expect(translateReplacement("$'")).toBe("$$'");
    expect(translateReplacement('100$')).toBe('100$$');
  });

  test('reads a Java-escaped dollar as a literal one', () => {
    expect(translateReplacement('\\$5')).toBe('$$5');
    expect(applyReplacements('X', [{ kind: 'regex', pattern: 'X', replacement: '\\$5', line: 1 }])).toBe(
      '$5',
    );
  });
});

describe('the replacements the Ork template declares', () => {
  const template = parseTemplate(readFileSync('fixtures/Ork-16x9.hde', 'utf8'));

  test('turn ASCII fractions into typographic ones', () => {
    const before = 'Reduced Endurance (1/2 END; +1/4) and HTH Damage 3 1/2d6';
    expect(applyReplacements(before, template.replacements)).toBe(
      'Reduced Endurance (½ END; +¼) and HTH Damage 3 ½d6',
    );
  });
});
