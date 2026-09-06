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

/**
 * The characters the renderer is held to, each with the moment its reference
 * sheet was exported. Redshift is a fifth-edition multipower character;
 * The Bismarck is a fifth-edition Elemental Control one, and between them they
 * cover most of what a sheet can say.
 */
const CHARACTERS = [
  { name: 'Redshift', savedAt: SAVED_AT },
  { name: 'The Bismarck', savedAt: new Date(2026, 8, 6, 18, 1, 6) },
] as const;

interface Rendering {
  readonly sheet: Sheet;
  readonly rendered: string;
  readonly expected: string;
}

const renderings = new Map<string, Rendering>();
const of = (name: string): Rendering => renderings.get(name) as Rendering;

let sheet: Sheet;
let rendered: string;

beforeAll(async () => {
  const library = await RulesLibrary.load();
  const template = parseTemplate(readFileSync('fixtures/Ork-16x9.hde', 'utf8'), {
    source: 'Ork-16x9.hde',
  });
  for (const { name, savedAt } of CHARACTERS) {
    const file = `${name}.hdc`;
    const character = parseCharacterFile(readFileSync(`fixtures/${file}`), file);
    const built = buildSheet(character, library.system(character.templateId), { strict: true });
    // Strict throughout: nothing is guessed at or skipped to make this pass.
    renderings.set(name, {
      sheet: built,
      rendered: applyReplacements(
        renderTemplate(
          template,
          createContext(built, {
            strict: true,
            characterFileName: file,
            saveTimestamp: savedAt,
            appVersion: APP_VERSION,
          }),
        ),
        template.replacements,
        { strict: true },
      ),
      expected: readFileSync(`fixtures/${name}.HTML`, 'utf8'),
    });
  }
  ({ sheet, rendered } = of('Redshift'));
});

// The acceptance gate: pure TypeScript reproducing HERO Designer's own export
// of each character, to the byte.
describe.each(CHARACTERS.map((entry) => entry.name))('rendering %s', (name) => {
  test('produces the same number of lines as the exported sheet', () => {
    const { rendered: ours, expected: theirs } = of(name);
    expect(ours.split('\n')).toHaveLength(theirs.split('\n').length);
  });

  test('reproduces the exported sheet exactly', () => {
    const { rendered: ours, expected: theirs } = of(name);
    const mine = ours.split('\n');
    const yours = theirs.split('\n');
    const differing = yours
      .map((line, index) => (mine[index] === line ? undefined : index + 1))
      .filter((line): line is number => line !== undefined);
    // Reported as line numbers so a regression says where, not just that.
    expect(differing).toEqual([]);
    expect(ours).toBe(theirs);
  });
});

describe('rendering the reference character', () => {
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

describe('The Bismarck, an Elemental Control character', () => {
  const bismarck = () => of('The Bismarck');

  test('fills in the document header', () => {
    expect(bismarck().rendered).toContain('<title>The Bismarck</title>');
    expect(bismarck().rendered).toContain('content="The Bismarck.hdc"');
    expect(bismarck().rendered).toContain('content="Sun, 6 Sep 2026 18:01:06"');
  });

  // An Elemental Control is quoted by what its slots may cost, which is twice
  // what the control itself does, and each slot pays its active cost less the
  // control's before its limitations divide it.
  test('prices an Elemental Control and its slots', () => {
    const { powers } = bismarck().sheet;
    const control = powers.find((power) => power.isFramework);
    expect([control?.text, control?.cost, control?.end]).toEqual([
      'Elemental Control, 10-point powers',
      '5',
      '',
    ]);
    const slot = (name: string) => powers.find((power) => power.source.name === name);
    expect(slot('smoke screen')?.cost).toBe('8');
    expect(slot('camera drone')?.cost).toBe('17');
    expect(slot('rocket jump')?.cost).toBe('7');
  });

  test('adds up to the totals on the sheet', () => {
    const { sheet: built } = bismarck();
    expect(built.points.totalPoints).toBe(383);
    expect(built.points.disadPointsUsed).toBe(145);
    expect(built.points.experienceSpent).toBe(63);
    expect(built.points.experienceUnspent).toBe(21);
  });

  // Armor is bought as points of defence and raises the characteristic line;
  // Damage Resistance only makes what is already there resistant.
  test('counts Armor towards PD and ED', () => {
    const { characteristics, defences } = bismarck().sheet;
    expect(characteristics.byId.get('PD')?.total).toBe(25);
    expect(characteristics.byId.get('ED')?.total).toBe(25);
    expect(defences.physical).toEqual({ total: 25, resistant: 25 });
  });

  // A Leaping power bought "Upward Movement Only" raises one half of the
  // character's leap without touching the other.
  test('leaps further up than forward', () => {
    expect(bismarck().rendered).toContain('<span class="primary">1"/10 ½"</span>');
    expect(bismarck().rendered).toContain('1" forward, 10 ½" upward');
  });

  test('describes the powers this character brought that Redshift did not', () => {
    const text = (name: string) =>
      bismarck().sheet.powers.find((power) => power.source.name === name)?.text;
    // A killing attack brackets its adders where an Energy Blast lists them.
    expect(text('@PLACEHOLDER artillery strike')).toBe(
      'Killing Attack - Ranged 1d6 (Custom Adder), Area Of Effect (One Hex; +1/2), ' +
        'Usable Simultaneously (up to 4 people at once; +3/4); 6 Charges (-3/4), ' +
        'Can Be Missile Deflected (-1/4), Gestures (-1/4), Extra Time (Delayed Phase, -1/4)',
    );
    // Linked names the power it is linked to, and Area Of Effect sizes itself
    // from what the power would cost without it.
    expect(text("the big gun's boom")).toBe(
      'Hearing Group Flash 3d6, Area Of Effect (4" Radius; +1 1/2) (22 Active Points); ' +
        'No Range (-1/2), Linked (the big gun; -1/2), Restrainable (-1/2)',
    );
    // A sense power names its groups, a Focus prints as the kind of focus it
    // is, and an adder that writes the power down to nothing leaves it free.
    expect(text('Starlight Cloak')).toBe(
      'Invisibility to Sight, Hearing, Radio and Smell/Taste Groups , Custom Adder, No Fringe, ' +
        'Reduced Endurance (0 END; +1/2) (1 Active Points); Independent (-2), OAF (-1), ' +
        'Conditional Power: Only at Night Power does not work in Very Common Circumstances (-1)',
    );
  });

  // A power that costs no endurance prints a bare zero; one that runs on
  // charges prints how many; and a talent leaves the column empty.
  test('prints the endurance column three different ways', () => {
    const end = (xmlId: string) =>
      bismarck().sheet.powers.find((power) => power.source.xmlId === xmlId)?.end;
    expect(end('ARMOR')).toBe('0');
    expect(end('RKA')).toBe('[6]');
    expect(end('ABSOLUTE_RANGE_SENSE')).toBe('');
  });

  // Combat skill levels are listed with the skills they were bought alongside
  // as well as in their own table, and are priced by what they apply to.
  test('lists combat skill levels in both tables', () => {
    const { skills, combatLevels } = bismarck().sheet;
    const level = combatLevels[0]!;
    expect([level.text, level.cost]).toEqual(['+3 with All Combat', 24]);
    expect(skills).toContain(level);
    // A skill that rolls brackets its subject; a familiarity does not.
    expect(skills.map((skill) => skill.text)).toContain('Navigation (Land)');
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
