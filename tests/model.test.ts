import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RulesLibrary } from '../src/rules/load.ts';
import { parseCharacterFile } from '../src/hdc/parse.ts';
import type { CharacterFile } from '../src/hdc/types.ts';
import type { RuleSystem } from '../src/rules/types.ts';
import {
  buildCharacteristics,
  characteristicDisplayValue,
  characteristicNotes,
  combatValue,
  phases,
  type CharacteristicSet,
} from '../src/model/characteristics.ts';
import {
  buildDisadvantage,
  buildManeuver,
  buildSimple,
  buildSkill,
  ruleFor,
  totalCost,
} from '../src/model/abilities.ts';
import { buildPower, totalPowerCost } from '../src/model/powers.ts';
import { summarisePoints } from '../src/model/points.ts';
import {
  formatDice,
  formatFraction,
  formatJavaDouble,
  formatRoll,
  formatSigned,
  roundHalfUp,
} from '../src/model/numbers.ts';
import { modifierText, sortedModifiers } from '../src/model/modifiers.ts';

let system: RuleSystem;
let character: CharacterFile;
let characteristics: CharacteristicSet;

beforeAll(async () => {
  system = (await RulesLibrary.load()).system('Superheroic');
  character = parseCharacterFile(readFileSync('fixtures/Redshift.hdc'), 'Redshift.hdc');
  // Combat Luck grants 6 resistant PD and ED.
  characteristics = buildCharacteristics(character.characteristics, system, [
    { id: 'PD', amount: 6 },
    { id: 'ED', amount: 6 },
  ]);
});

describe('number formatting', () => {
  // Some values reach the page as raw Java doubles.
  test('matches Java Double.toString, including the trailing .0', () => {
    expect(formatJavaDouble(26 / 3)).toBe('8.666666666666666');
    expect(formatJavaDouble(9)).toBe('9.0');
    expect(formatJavaDouble(3.6)).toBe('3.6');
  });

  // Templates convert 1/2 to ½ themselves, so the engine must not do it early.
  test('writes fractions in the ASCII form templates expect', () => {
    expect(formatFraction(3.5)).toBe('3 1/2');
    expect(formatFraction(0.25)).toBe('1/4');
    expect(formatFraction(4)).toBe('4');
    expect(formatSigned(0.25)).toBe('+1/4');
    expect(formatSigned(-0.25)).toBe('-1/4');
  });

  test('counts dice in fives with a half die at three', () => {
    expect(formatDice(35)).toBe('7d6');
    expect(formatDice(18)).toBe('3 1/2d6');
    expect(formatDice(17)).toBe('3d6+1');
  });

  test('rounds halves up, and is not fooled by floating point drift', () => {
    expect(formatRoll(18)).toBe('13-');
    expect(roundHalfUp(1.5)).toBe(2);
    // REC's exact cost lands on 16.400000000000002; it must not round to 17.
    expect(roundHalfUp(16.400000000000002)).toBe(16);
    expect(roundHalfUp(6.800000000000001 * 2)).toBe(14);
  });
});

describe('characteristics', () => {
  // Value, base, cost and notes for every row of the exported sheet.
  const expected: Record<string, [string, string, number, string]> = {
    STR: ['18', '10', 8, 'HTH Damage 3 1/2d6  END [2]'],
    DEX: ['26', '10', 48, 'OCV 9 DCV 9'],
    CON: ['16', '10', 12, ''],
    BODY: ['12', '10', 4, ''],
    INT: ['18', '10', 8, 'PER Roll 13-'],
    EGO: ['14', '10', 8, 'ECV: 5'],
    PRE: ['18', '10', 8, 'PRE Attack: 3 1/2d6'],
    COM: ['13', '10', 2, ''],
    PD: ['12', '4', 2, '12 PD (12 rPD)'],
    ED: ['12', '3', 3, '12 ED (12 rED)'],
    SPD: ['5', '3.6', 14, 'Phases:  3, 5, 8, 10, 12'],
    REC: ['15', '7', 16, ''],
    END: ['35', '32', 2, ''],
    STUN: ['35', '29', 6, ''],
    RUNNING: ['20', '6', 28, 'END [4]'],
    SWIMMING: ['2', '2', 0, 'END [1]'],
    LEAPING: ['3 1/2"/1 1/2"', '4', 0, '3 1/2" forward, 1 1/2" upward'],
  };

  test('reproduces every row of the sheet', () => {
    const defences = { PD: { total: 12, resistant: 12 }, ED: { total: 12, resistant: 12 } };
    for (const characteristic of characteristics.all) {
      const [value, base, cost, notes] = expected[characteristic.id]!;
      expect({
        value: characteristicDisplayValue(characteristic),
        base: String(characteristic.base),
        cost: characteristic.cost,
        notes: characteristicNotes(
          characteristic,
          characteristics,
          system,
          defences[characteristic.id as 'PD' | 'ED'],
        ),
      }).toEqual({ value, base, cost, notes });
    }
  });

  // The rows show 2, 2 and 16 while contributing 1.5, 1.5 and 16.4: adding the
  // displayed numbers gives 169, and the sheet says 168.
  test('totals exact costs rather than displayed ones', () => {
    expect(characteristics.totalCost).toBe(168);
    const naive = characteristics.all.reduce((sum, entry) => sum + entry.cost, 0);
    expect(naive).toBe(169);
  });

  // Figured bases come from the rules data, not a hard-coded table: STR carries
  // PDINCREASE="1" PDINCREASELEVELS="5".
  test('derives figured bases from the rules', () => {
    expect(characteristics.byId.get('PD')?.rawBase).toBeCloseTo(3.6, 9);
    expect(characteristics.byId.get('STUN')?.rawBase).toBe(29);
    expect(characteristics.byId.get('SPD')?.rawBase).toBeCloseTo(3.6, 9);
  });

  test('figures combat values from DEX and EGO in fifth edition', () => {
    expect(formatJavaDouble(combatValue(characteristics, system, 'OCV')!)).toBe('8.666666666666666');
    expect(roundHalfUp(combatValue(characteristics, system, 'ECV')!)).toBe(5);
  });

  test('works out which segments a character acts in', () => {
    expect(phases(5)).toEqual([3, 5, 8, 10, 12]);
    expect(phases(2)).toEqual([6, 12]);
    expect(phases(12)).toHaveLength(12);
  });
});

describe('skills', () => {
  test('reproduces all 29 rows and the total', () => {
    const expected: [string, string, number][] = [
      ['14-', 'Acting', 5], ['14-', 'Acrobatics', 3], ['14-', 'Breakfall', 3],
      ['14-', 'Bribery', 5], ['13-', 'Bugging', 3], ['13-', 'Bureaucratics', 3],
      ['13-', 'Computer Programming', 3], ['13-', 'Demolitions', 3], ['13-', 'Disguise', 3],
      ['13-', 'Electronics', 3], ['13-', 'Gambling', 3], ['13-', 'KS: logistics', 3],
      ['13-', 'KS: US military', 3], ['', 'Language:  German (basic conversation)', 1],
      ['13-', 'Mechanics', 3], ['14-', 'Oratory', 5], ['13-', 'Paramedics', 3],
      ['14-', 'Persuasion', 5], ['13-', 'Security Systems', 3], ['11-', 'Science Skill:  physics', 2],
      ['13-', 'Shadowing', 3], ['14-', 'Sleight Of Hand', 3], ['14-', 'Stealth', 3],
      ['13-', 'Systems Operation', 3], ['13-', 'Tactics', 3], ['14-', 'Teamwork', 3],
      ['', 'TF:  Common Motorized Ground Vehicles', 2], ['13-', 'Tracking', 3],
      ['', 'WF:  Common Melee Weapons, Small Arms', 4],
    ];
    const built = character.skills.map((skill) => buildSkill(skill, system, characteristics));
    expect(built.map((s) => [s.roll, s.text, s.cost])).toEqual(expected);
    expect(totalCost(built)).toBe(92);
  });

  // Language and the familiarities define no FAMILIARITYROLL and show no roll.
  test('shows a roll only when the rules give the skill one', () => {
    const language = character.skills.find((s) => s.xmlId === 'LANGUAGES')!;
    expect(buildSkill(language, system, characteristics).roll).toBe('');
  });
});

describe('talents', () => {
  test('prices talents from the rules, per level', () => {
    const built = character.talents.map((t) => buildSimple(t, ruleFor(system, 'TALENTS', t.xmlId)));
    expect(built.map((t) => [t.text, t.cost])).toEqual([
      ['Combat Luck (6 PD/6 ED)', 12],
      ['Lightning Reflexes: +4 DEX to act first with All Actions', 6],
    ]);
    expect(totalCost(built)).toBe(18);
  });
});

describe('disadvantages', () => {
  test('reproduces all 13 rows and the total', () => {
    const expected: [string, number][] = [
      ["Distinctive Features:  doesn't age (Easily Concealed; Noticed and Recognizable; Detectable By Commonly-Used Senses)", 5],
      ['Distinctive Features:  abnormally slow biology (pulse, breathing rate, blinking, etc) (Not Concealable; Noticed and Recognizable; Detectable By Commonly-Used Senses)', 15],
      ['Hunted:  Overwatch 8- (Mo Pow; Watching)', 5],
      ['Hunted:  US Government 8- (Mo Pow; Watching)', 5],
      ['Physical Limitation:  distorted sense of time passage (Frequently; Slightly Impairing)', 10],
      ['Psychological Limitation:  emotionally distant (Uncommon; Strong)', 10],
      ['Psychological Limitation:  protect the innocent (Common; Strong)', 15],
      ['Psychological Limitation:  uses powers sparingly (Very Common; Strong)', 20],
      ['Reputation:  "The boy who never grew old", 11-', 10],
      ['Social Limitation:  constantly fidgety and impatient (Frequently; Major)', 15],
      ['Social Limitation:  underage (Very Frequently; Minor)', 15],
      ['Social Limitation:  secret identity (Frequently; Major)', 15],
      ['Vulnerability:  2 x STUN high energy radiation (Uncommon)', 10],
    ];
    const built = character.disadvantages.map((d) =>
      buildDisadvantage(d, ruleFor(system, 'DISADVANTAGES', d.xmlId)),
    );
    expect(built.map((d) => [d.text, d.cost])).toEqual(expected);
    expect(totalCost(built)).toBe(150);
  });

  // A Vulnerability's multiplier is a modifier worth +1, which both names the
  // effect and doubles the points.
  test('lets a modifier qualify and multiply a disadvantage', () => {
    const vulnerability = character.disadvantages.find((d) => d.xmlId === 'VULNERABILITY')!;
    const built = buildDisadvantage(vulnerability, ruleFor(system, 'DISADVANTAGES', 'VULNERABILITY'));
    expect(built.text).toContain('2 x STUN high energy radiation');
    expect(built.cost).toBe(10);
  });
});

describe('martial maneuvers', () => {
  test('reads the columns from the character file', () => {
    const built = character.martialArts.map((m) => buildManeuver(m, 18));
    expect(built.map((m) => [m.name, m.phase, m.ocv, m.dcv, m.cost])).toEqual([
      ['Martial Dodge', '1/2', '--', '+5', 4],
      ['Passing Disarm', '1/2', '-1', '-1', 5],
      ['Passing Strike', '1/2', '+1', '+0', 5],
    ]);
    expect(built[0]?.effect).toBe('Dodge, Affects All Attacks, Abort');
  });
});

describe('modifiers', () => {
  test('lists modifiers cheapest first, keeping file order within a tie', () => {
    const power = character.powers.find((p) => p.xmlId === 'CHANGEENVIRONMENT')!;
    expect(sortedModifiers(power.modifiers).map((m) => m.xmlId)).toEqual([
      'REDUCEDEND',
      'AFFECTSDESOLID',
      'SELECTIVETARGET',
      'BOECV',
    ]);
  });

  test('brackets the option, unless a comment takes its place', () => {
    const power = character.powers.find((p) => p.xmlId === 'CHANGEENVIRONMENT')!;
    const byId = (id: string) => modifierText(power.modifiers.find((m) => m.xmlId === id)!).text;
    expect(byId('REDUCEDEND')).toBe('Reduced Endurance (1/2 END; +1/4)');
    expect(byId('SELECTIVETARGET')).toBe('Selective Target (+1/2)');
    expect(byId('AFFECTSDESOLID')).toBe(
      "Affects Desolidified One Special Effect of Desolidification (only if the body's form is still reasonably intact; +1/4)",
    );
  });

  test('drops an option that only repeats the modifier name', () => {
    const healing = character.powers.find((p) => p.xmlId === 'HEALING')!;
    const ranged = healing.modifiers.find((m) => m.xmlId === 'RANGED')!;
    expect(modifierText(ranged).text).toBe('Ranged (+1/2)');
  });
});

describe('powers', () => {
  test('describes and prices the powers it covers', () => {
    const built = character.powers.map((p) => buildPower(p, system, { strict: false }));
    const rows = built.map((p) => [p.end, p.text, p.cost] as const);
    expect(rows[0]).toEqual(['0', 'Damage Resistance (6 PD/6 ED)', '6']);
    expect(rows[1]).toEqual(['0', 'Power Defense (5 points)', '5']);
    expect(rows[2]).toEqual(['0', 'Sight Group Flash Defense (5 points)', '5']);
    expect(rows[3]).toEqual(['', 'Multipower, 75-point reserve', '75']);
    expect(rows[6]).toEqual([
      '3',
      'Stretching 6", Does Not Cross Intervening Space (+1/4), Reduced Endurance (1/2 END; +1/4), Invisible Power Effects (Fully Invisible; +1) (75 Active Points)',
      '7u',
    ]);
    expect(rows[7]).toEqual(['7', 'Stretching 15" (75 Active Points); Always Direct (-1/4)', '6u']);
    expect(rows[8]).toEqual([
      '7',
      'Healing STUN 5d6, Ranged (+1/2) (75 Active Points); Gestures (-1/4)',
      '6u',
    ]);
  });

  test('refuses a power it cannot describe, unless asked not to', () => {
    const unknown = { ...character.powers[0]!, xmlId: 'INVENTED_POWER', alias: 'Invented Power' };
    expect(() => buildPower(unknown, system)).toThrow(/does not know how to describe yet/);
    expect(() => buildPower(unknown, system, { strict: false })).not.toThrow();
  });
});

describe('points', () => {
  test('works out experience from what has been spent', () => {
    const summary = summarisePoints({
      basePoints: 250,
      disadPointsAllowed: 150,
      experienceEarned: 25,
      disadPointsUsed: 150,
      characteristics: 168,
      skills: 92,
      perks: 0,
      talents: 18,
      martialArts: 14,
      powers: 124,
    });
    expect(summary).toEqual({
      basePoints: 250,
      disadPointsAllowed: 150,
      disadPointsUsed: 150,
      experienceEarned: 25,
      experienceSpent: 16,
      experienceUnspent: 9,
      totalPoints: 416,
    });
  });

  test('adds up the sections of the fixture character', () => {
    const skills = totalCost(character.skills.map((s) => buildSkill(s, system, characteristics)));
    const talents = totalCost(
      character.talents.map((t) => buildSimple(t, ruleFor(system, 'TALENTS', t.xmlId))),
    );
    const martialArts = roundHalfUp(
      character.martialArts.map(buildManeuver).reduce((sum, m) => sum + m.cost, 0),
    );
    expect([characteristics.totalCost, skills, talents, martialArts]).toEqual([168, 92, 18, 14]);
    // Powers reach 124 once Change Environment's area is worked out; see README.
    expect(totalPowerCost(character.powers.map((p) => buildPower(p, system, { strict: false })))).toBe(121);
  });
});
