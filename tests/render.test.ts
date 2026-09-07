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
 * sheet was exported. Redshift is a fifth-edition multipower character; The
 * Bismarck is a fifth-edition Elemental Control one; Azarra groups her powers
 * into lists and keeps most of them in a suit she can be parted from; and
 * Porcelain changes size, lends her powers to other people, and carries the
 * defences and senses the others do not. Between them they cover most of what a
 * sheet can say.
 */
const CHARACTERS = [
  { name: 'Redshift', savedAt: SAVED_AT },
  { name: 'The Bismarck', savedAt: new Date(2026, 8, 6, 18, 1, 6) },
  { name: 'Azarra', savedAt: new Date(2026, 8, 6, 19, 34, 26) },
  { name: 'Porcelain', savedAt: new Date(2026, 8, 7, 10, 32, 24) },
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

describe('Azarra, whose powers live in a suit', () => {
  const azarra = () => of('Azarra');

  test('fills in the document header', () => {
    expect(azarra().rendered).toContain('<title>Azarra</title>');
    expect(azarra().rendered).toContain('content="Azarra.hdc"');
    expect(azarra().rendered).toContain('content="Sun, 6 Sep 2026 19:34:26"');
  });

  // A list is a heading the player groups entries under. It is not an ability:
  // it costs nothing, uses no endurance, and prints nothing but its name.
  test('heads its powers and disadvantages with lists', () => {
    const { sheet: built, rendered } = azarra();
    const list = built.powers.find((power) => power.source.element === 'LIST');
    expect([list?.text, list?.cost, list?.end]).toEqual(['FSH Combat Suit', '', '']);
    expect(rendered).toContain('<td class="text-start list ">\n\nFSH Combat Suit');
    // The same markup marks a list among the disadvantages.
    expect(built.disadvantages.filter((disad) => disad.isList).map((disad) => disad.text))
      .toEqual(['Distinctive Features', 'Hunted', 'Psych Limits']);
    expect(rendered).toContain('<td class="list ">\nDistinctive Features');
    expect(rendered).toContain('<td class=" list-item">\nDistinctive Features:  Kayzon');
  });

  // Armor bought in a suit raises what the character has but not what she has
  // without it, and both figures reach the sheet.
  test('prints defence she can be parted from as a second figure', () => {
    const { sheet: built, rendered } = azarra();
    expect(built.defences.physical).toEqual({ total: 16, resistant: 10 });
    expect(built.defences.primaryPhysical).toEqual({ total: 6, resistant: 0 });
    expect(built.characteristics.byId.get('PD')?.primary).toBe(6);
    expect(built.characteristics.byId.get('PD')?.total).toBe(16);
    expect(rendered).toContain('<span class="primary">6</span>\n/ <span class="secondary">16</span>');
    expect(rendered).toContain('6/16 PD (0/10 rPD)');
  });

  // A talent marked as affecting neither figure contributes to neither, which
  // is why Combat Luck's 3 resistant points appear nowhere above.
  test('counts nothing from a talent switched off on both counts', () => {
    const luck = azarra().sheet.talents.find((talent) => talent.source.xmlId === 'COMBAT_LUCK');
    expect(luck?.source.attributes['AFFECTS_TOTAL']).toBe('No');
    expect(azarra().sheet.characteristics.byId.get('PD')?.total).toBe(16);
  });

  // Skills and talents take advantages and limitations exactly as powers do.
  test('prices a skill and a talent bought with limitations', () => {
    const { skills, talents } = azarra().sheet;
    const level = skills.find((skill) => skill.source.xmlId === 'COMBAT_LEVELS');
    expect([level?.text, level?.cost]).toEqual([
      '+4 with DCV (20 Active Points); OIF (suit; -1/2)',
      13,
    ]);
    const luck = talents.find((talent) => talent.source.xmlId === 'COMBAT_LUCK');
    // The modifier's own name ends in a space, so its value follows two of them.
    expect([luck?.text, luck?.cost]).toEqual([
      'Combat Luck (3 PD/3 ED) (6 Active Points); Requires A DEX Roll  (-1/2)',
      4,
    ]);
    const penalty = skills.find((skill) => skill.source.xmlId === 'PENALTY_SKILL_LEVELS');
    expect([penalty?.text, penalty?.cost]).toEqual([
      'Penalty Skill Levels:  +4 vs. Range Modifier with a tight group of attacks (grapnel)',
      8,
    ]);
  });

  // A movement power that raises its characteristic says what the total becomes
  // and lifts the distance and endurance printed against it.
  test('adds bought movement to the characteristic it is named after', () => {
    const { sheet: built, rendered } = azarra();
    const running = built.powers.find((power) => power.source.element === 'RUNNING');
    expect(running?.text.startsWith('Running +6" (12" total)')).toBe(true);
    expect(built.characteristics.byId.get('RUNNING')?.total).toBe(12);
    expect(rendered).toContain('END [2]');
    // Stretching raises no characteristic, so it just says how far it reaches.
    const stretching = built.powers.find((power) => power.source.xmlId === 'STRETCHING');
    expect(stretching?.text.startsWith('Stretching 16"')).toBe(true);
  });

  test('describes the powers this character brought that the others did not', () => {
    const text = (xmlId: string) =>
      azarra().sheet.powers.find((power) => power.source.xmlId === xmlId)?.text;
    // A sense modifier names the sense it sharpens rather than bracketing it,
    // and Enhanced Perception says how many levels it bought.
    expect(text('ENHANCEDPERCEPTION')).toBe('+5 PER with Normal Hearing');
    expect(text('DISCRIMINATORY')).toBe('Discriminatory with Normal Smell');
    // Clinging holds on with the character's own STR plus what was bought.
    expect(text('CLINGING')?.startsWith('Clinging (25 STR)')).toBe(true);
    // A characteristic bought as a power says how much it adds.
    expect(text('STR')?.startsWith('+23 STR')).toBe(true);
    // An Entangle is as hard to break out of as it is strong.
    expect(text('ENTANGLE')?.startsWith('Entangle 8d6, 8 DEF')).toBe(true);
    // Life Support separates the environments it covers with semicolons.
    expect(text('LIFESUPPORT')).toContain('(Safe in High Pressure; Safe in High Radiation;');
  });

  // The store and its recovery are bought and limited separately, so each half
  // prints its own modifiers and the sheet charges for both.
  test('prices an Endurance Reserve and its recovery apart', () => {
    const reserve = azarra().sheet.powers.find((power) => power.source.xmlId === 'ENDURANCERESERVE');
    expect(reserve?.text).toBe(
      'Endurance Reserve  (100 END, 10 REC) Reserve:  (20 Active Points); ' +
        'IIF (suit, detectable by localized electrical activity; -1/4); REC:  (10 Active Points); ' +
        'Limited Recovery (standard electrical socket; -2)',
    );
    expect([reserve?.cost, reserve?.end]).toEqual(['11', '0']);
  });

  // A skill can be bought as a power. It reads as a skill, roll and all, and is
  // priced as a power: its skill cost is what the limitations then divide.
  test('renders a skill bought as a power', () => {
    const mimicry = azarra().sheet.powers.find((power) => power.source.xmlId === 'MIMICRY');
    expect(mimicry?.text).toBe(
      'Mimicry 17- (11 Active Points); Costs Endurance (-1/2), Only In Heroic Identity (-1/4)',
    );
    expect([mimicry?.cost, mimicry?.end]).toEqual(['6', '1']);
  });

  // Charges that go on working once spent say for how long, and are marked in
  // the endurance column.
  test('marks continuing charges in the endurance column', () => {
    const smoke = azarra().sheet.powers.find((power) => power.source.name === 'smoke grenade');
    expect(smoke?.end).toBe('[4 cc]');
    expect(smoke?.text).toContain('4 Continuing Charges lasting 1 Minute each (-1/4)');
  });

  // Enhanced Perception worn in a suit sharpens the roll only while it is on.
  test('prints both perception rolls', () => {
    expect(azarra().rendered).toContain('PER Roll 13-/18-');
  });

  // Inside the bracket the dearest option comes first, whichever way round the
  // character file stores them; what comes before it stays as written.
  test('orders a disadvantage’s options by what they cost', () => {
    const hunted = azarra().sheet.disadvantages.filter((disad) => disad.source.xmlId === 'HUNTED');
    expect(hunted.map((disad) => disad.text)).toEqual([
      'Hunted:  FSH wants their suit back 8- (Mo Pow; NCI; Capture)',
      'Hunted:  Kay local law enforcement 8- (Mo Pow; Capture)',
    ]);
    // A disadvantage with no subject introduces its first option as one.
    const money = azarra().sheet.disadvantages.find((disad) => disad.source.xmlId === 'MONEYDISAD');
    expect(money?.text).toBe('Money:  Poor');
  });

  test('adds up to the totals on the sheet', () => {
    const { points } = azarra().sheet;
    expect(points.totalPoints).toBe(400);
    expect(points.experienceSpent).toBe(0);
    expect(points.experienceUnspent).toBe(15);
  });
});

describe('Porcelain, who changes size', () => {
  const porcelain = () => of('Porcelain');

  test('fills in the document header', () => {
    expect(porcelain().rendered).toContain('<title>Porcelain</title>');
    expect(porcelain().rendered).toContain('content="Porcelain.hdc"');
    expect(porcelain().rendered).toContain('content="Mon, 7 Sep 2026 10:32:24"');
  });

  // Growth and Shrinking quote the character's own height and weight — kept as
  // inches and pounds in the file, printed as metres and kilogrammes — against
  // the per-level figures in the rules. Growth rounds them to whole units where
  // Shrinking measures to four decimal places.
  test('measures the character growing and shrinking', () => {
    const text = (xmlId: string) =>
      porcelain().sheet.powers.find((power) => power.source.xmlId === xmlId)?.text;
    expect(text('GROWTH')?.startsWith(
      'Growth (+30 STR, +6 BODY, +6 STUN, -6" KB, 2,496 kg, -4 DCV, ' +
        '+4 PER Rolls to perceive character, 7 m tall, 3 m wide)',
    )).toBe(true);
    expect(text('SHRINKING')?.startsWith(
      'Shrinking (0.2037 m tall, 0.0762 kg mass, -6 PER Rolls to perceive character, +6 DCV)',
    )).toBe(true);
  });

  test('describes the powers this character brought that the others did not', () => {
    const text = (xmlId: string) =>
      porcelain().sheet.powers.find((power) => power.source.xmlId === xmlId)?.text;
    // Detect names what it senses, the roll to notice it, and its sense group.
    expect(text('DETECT')).toBe('Detect A Single Thing 13- (Sight Group)');
    // Mental Defense counts the character's own EGO towards its points.
    expect(text('MENTALDEFENSE')).toBe('Mental Defense (13 points total)');
    // Clinging bought at no levels holds on with nothing but the character.
    expect(text('CLINGING')?.startsWith('Clinging (normal STR)')).toBe(true);
    // Telekinesis lifts with a strength of its own.
    expect(text('TELEKINESIS')?.startsWith('Telekinesis (40 STR)')).toBe(true);
    expect(text('EXTRALIMBS')).toBe('Extra Limbs  (2)');
    // Shape Shift brackets its sense group with the shapes it can take.
    expect(text('SHAPESHIFT')?.startsWith('Shape Shift  (Sight Group, any shape)')).toBe(true);
    // Desolidification keeps the space where what it is affected by would go.
    expect(text('DESOLIDIFICATION')?.startsWith('Desolidification ,')).toBe(true);
    // Armor bought against one kind of damage still says how much it stops of
    // the other.
    expect(text('ARMOR')?.startsWith('Armor (6 PD/0 ED)')).toBe(true);
  });

  // A Mental Defense power brings the character's EGO with it; a character
  // without one shows no mental defence however high their EGO.
  test('counts EGO towards mental defence', () => {
    expect(porcelain().sheet.defences.mental).toBe(13);
    expect(of('Redshift').sheet.defences.mental).toBe(0);
    expect(porcelain().rendered).toContain('<td class="text-start">Mental</td>\n<td>13</td>');
  });

  // A combat level can be bought as a power, and then belongs in the combat
  // level table as much as one bought among the skills does.
  test('lists a combat level bought as a power', () => {
    const { combatLevels, skills } = porcelain().sheet;
    expect(combatLevels).toHaveLength(1);
    expect(combatLevels[0]?.source.element).toBe('SKILL');
    expect(combatLevels[0]?.text.startsWith('+3 with All Combat, Ranged (+1/2)')).toBe(true);
    expect(skills.some((skill) => skill.source.xmlId === 'COMBAT_LEVELS')).toBe(false);
    expect(porcelain().rendered).toContain('id="combat-skill-levels-block"');
  });

  // A skill taken only as a familiarity rolls against the flat number the rules
  // give it, however good the characteristic behind it is.
  test('rolls a familiarity against its own number', () => {
    const rolls = porcelain().sheet.skills
      .filter((skill) => skill.source.attributes['FAMILIARITY'] === 'Yes')
      .map((skill) => [skill.text, skill.roll]);
    expect(rolls).toEqual([
      ['High Society (Custom Adder)', '8-'],
      ['Science Skill:  meteorology', '8-'],
    ]);
  });

  // A Reputation is written one way as a perk and another as a disadvantage,
  // and the disadvantage's second bracketed option continues the first's group
  // rather than opening one of its own.
  test('writes a reputation both ways round', () => {
    expect(porcelain().sheet.perks.map((perk) => perk.text)).toEqual([
      'Reputation:  rescuer, healer (A large group) 11-, +1/+1d6',
    ]);
    const disad = porcelain().sheet.disadvantages
      .find((entry) => entry.source.xmlId === 'REPUTATION');
    expect(disad?.text).toBe('Reputation:  The Dream Stealer, 11- (Extreme;  Known Only To A Small Group)');
  });

  // A movement power that raises the characteristic charges its own endurance
  // on top of what the character's own movement costs: 10" of her for 2 END,
  // and another 10" of slip for the power's 4.
  test('adds a movement power’s endurance to the characteristic’s own', () => {
    const { sheet: built, rendered } = porcelain();
    expect(built.characteristics.byId.get('RUNNING')?.value).toBe(10);
    expect(built.characteristics.byId.get('RUNNING')?.total).toBe(20);
    expect(built.powers.find((power) => power.source.element === 'RUNNING')?.end).toBe('4');
    expect(rendered).toContain('END [6]');
  });

  // Each figured contribution is rounded as it is taken: STR 15 and CON 21 give
  // 8 and 11, not the 7.5 and 10.5 that would total a point lower. SPD is the
  // exception, and prints its tenths whether it has any or not.
  test('figures the bases the sheet shows', () => {
    const { characteristics } = porcelain().sheet;
    expect(characteristics.byId.get('STUN')?.base).toBe(39);
    expect(characteristics.byId.get('SPD')?.base).toBe(3);
    expect(porcelain().rendered).toContain('<td>SPD</td>\n<td>3.0</td>');
    // STR 15 spends a point of endurance, not the two it would round up to.
    expect(porcelain().rendered).toContain('HTH Damage 3d6  END [1]');
  });

  test('adds up to the totals on the sheet', () => {
    const { points } = porcelain().sheet;
    expect(points.totalPoints).toBe(472);
    expect(points.disadPointsUsed).toBe(115);
    expect(points.experienceSpent).toBe(57);
    expect(points.experienceUnspent).toBe(19);
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
