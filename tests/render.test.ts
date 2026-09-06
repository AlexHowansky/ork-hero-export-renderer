import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RulesLibrary } from '../src/rules/load.ts';
import { parseCharacterFile } from '../src/hdc/parse.ts';
import { parseTemplate } from '../src/template/parser.ts';
import { renderTemplate } from '../src/template/renderer.ts';
import { applyReplacements } from '../src/template/postprocess.ts';
import { buildSheet, type Sheet } from '../src/tags/sheet.ts';
import { createContext, formatTimestamp } from '../src/tags/context.ts';
import { evaluateMath } from '../src/tags/math.ts';
import { silentLogger } from '../src/util/logger.ts';
import { HeroError } from '../src/util/errors.ts';

/** Pinned so the comparison does not depend on when or where it runs. */
const SAVED_AT = new Date(2026, 8, 6, 10, 36, 50);
const APP_VERSION = '20260405';

let sheet: Sheet;
let rendered: string;
let expected: string;

beforeAll(async () => {
  const library = await RulesLibrary.load();
  const character = parseCharacterFile(readFileSync('fixtures/Redshift.hdc'), 'Redshift.hdc');
  sheet = buildSheet(character, library.system(character.templateId), { strict: true });
  const template = parseTemplate(readFileSync('fixtures/Ork-16x9.hde', 'utf8'), {
    source: 'Ork-16x9.hde',
  });
  // Strict throughout: nothing is guessed at or skipped to make this pass.
  rendered = applyReplacements(
    renderTemplate(
      template,
      createContext(sheet, {
        strict: true,
        characterFileName: 'Redshift.hdc',
        saveTimestamp: SAVED_AT,
        appVersion: APP_VERSION,
      }),
    ),
    template.replacements,
    { strict: true },
  );
  expected = readFileSync('fixtures/Redshift.HTML', 'utf8');
});

describe('rendering the reference character', () => {
  test('produces the same number of lines as the exported sheet', () => {
    expect(rendered.split('\n')).toHaveLength(expected.split('\n').length);
  });

  // The acceptance gate: pure TypeScript reproducing HERO Designer's own
  // export of this character, to the byte.
  test('reproduces the exported sheet exactly', () => {
    const ours = rendered.split('\n');
    const theirs = expected.split('\n');
    const differing = theirs
      .map((line, index) => (ours[index] === line ? undefined : index + 1))
      .filter((line): line is number => line !== undefined);
    // Reported as line numbers so a regression says where, not just that.
    expect(differing).toEqual([]);
    expect(rendered).toBe(expected);
  });

  test('embeds the character portrait byte for byte', () => {
    const hex = Buffer.from(sheet.character.image?.base64 ?? '', 'base64').toString('hex');
    expect(rendered).toContain(`const imageHex = '${hex}'`);
    expect(rendered).toContain("const imageName = 'redshift small.png'");
  });

  test('fills in the document header', () => {
    expect(rendered).toContain('<title>Redshift</title>');
    expect(rendered).toContain(`content="${APP_VERSION}"`);
    expect(rendered).toContain('content="Redshift.hdc"');
    expect(rendered).toContain('content="Sun, 6 Sep 2026 10:36:50"');
  });

  // A fifth-edition character has no OMCV, so the probe the template uses to
  // detect the edition must collapse to nothing.
  test('renders a characteristic container the character does not have as empty', () => {
    expect(rendered).toContain('<body data-edition="">');
  });

  test('injects the player’s own stylesheet with its line breaks removed', () => {
    expect(rendered).toContain("<style>@import url('https://fonts.cdnfonts.com/css/astro-futuristic-font');");
    expect(sheet.character.info.campaignUse).toContain('\n');
  });

  // The framework is a list and its slots are items; a standalone power is
  // neither, leaving the two spaces the template puts between the classes.
  test('marks framework slots apart from standalone powers', () => {
    expect(rendered).toContain('<td class="text-start list ">');
    expect(rendered).toContain('<td class="text-start  list-item">');
    expect(rendered).toContain('<td class="text-start  ">');
  });

  test('leaves tags it does not know exactly as written', () => {
    expect(rendered).toContain('<!--PRIMARY_OMCV-->');
    expect(rendered).toContain('<!--PRIMARY_DMCV-->');
  });

  test('prints combat values the way HERO Designer does', () => {
    // Unrounded for OCV, rounded but still a double for DCV.
    expect(rendered).toContain('8.666666666666666');
    expect(rendered).toContain('9.0');
  });

  test('applies the template’s own fraction replacements', () => {
    expect(rendered).toContain('HTH Damage 3 ½d6');
    expect(rendered).toContain('Reduced Endurance (½ END; +¼)');
    expect(rendered).not.toContain('1/2d6');
  });
});

describe('point totals on the sheet', () => {
  test('reports each section', () => {
    expect(sheet.characteristics.totalCost).toBe(168);
    expect(sheet.points.basePoints).toBe(250);
    expect(sheet.points.disadPointsUsed).toBe(150);
    expect(sheet.points.experienceEarned).toBe(25);
  });

  test('computes the defences the sheet shows', () => {
    expect(sheet.defences.physical).toEqual({ total: 12, resistant: 12 });
    expect(sheet.defences.energy).toEqual({ total: 12, resistant: 12 });
    expect(sheet.defences.mental).toBe(0);
    expect(sheet.defences.power).toBe(5);
  });
});

describe('MATH blocks', () => {
  const evaluate = (expression: string) =>
    evaluateMath(expression, { strict: true, logger: silentLogger });

  test('works out the arithmetic a template asks for', () => {
    expect(evaluate('75/5')).toBe('15');
    expect(evaluate(' 2 + 3 * 4 ')).toBe('14');
    expect(evaluate('(2 + 3) * 4')).toBe('20');
    expect(evaluate('2^3')).toBe('8');
    expect(evaluate('-6/4')).toBe('-1.5');
  });

  // The expression comes from a template file, so it is parsed, never executed.
  test('refuses anything that is not arithmetic', () => {
    expect(() => evaluate('process.exit(1)')).toThrow(HeroError);
    expect(() => evaluate('1 +')).toThrow(/Could not work out the calculation/);
    expect(() => evaluate('(1 + 2')).toThrow(HeroError);
  });

  test('can be told to leave a bad calculation blank instead', () => {
    expect(evaluateMath('oops', { strict: false, logger: silentLogger })).toBe('');
  });
});

describe('formatTimestamp', () => {
  test('matches the format HERO Designer stamps on an export', () => {
    expect(formatTimestamp(new Date(2026, 8, 6, 10, 36, 50))).toBe('Sun, 6 Sep 2026 10:36:50');
    expect(formatTimestamp(new Date(2026, 11, 25, 9, 5, 4))).toBe('Fri, 25 Dec 2026 09:05:04');
  });
});
