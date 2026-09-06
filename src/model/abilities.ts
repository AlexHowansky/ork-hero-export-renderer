import type { Ability } from '../hdc/types.ts';
import { isYes } from '../hdc/parse.ts';
import type { RuleNode, RuleSystem, SectionName } from '../rules/types.ts';
import { formatDice, formatRoll, roundHalfUp } from './numbers.ts';
import { adderText, adderTotal, advantageTotal } from './modifiers.ts';
import type { CharacteristicSet } from './characteristics.ts';

/**
 * Skills, perks, talents, disadvantages and martial maneuvers: everything whose
 * sheet entry is a name, a cost, and sometimes a roll.
 *
 * Powers are more involved and live in their own module.
 */

/** A characteristic-based skill costs this much before levels, when the character file does not say. */
const DEFAULT_SKILL_COST = 3;
/** Each level above the base costs this much. */
const SKILL_LEVEL_COST = 2;
/** Skills bought against no characteristic roll at this, plus levels. */
const GENERAL_SKILL_ROLL = 11;

/**
 * What HERO Designer puts between a name and its subject. It is two spaces,
 * not one — "Language:  German", "Hunted:  Overwatch".
 */
const SUBJECT_SEPARATOR = ':  ';

export interface RenderedAbility {
  readonly source: Ability;
  /** The Description column, without the player's own name for the item. */
  readonly text: string;
  /** The Roll column; empty when the item has none. */
  readonly roll: string;
  readonly rawCost: number;
  readonly cost: number;
  readonly notes: string;
}

export function ruleFor(system: RuleSystem, section: SectionName, id: string): RuleNode | undefined {
  return system.sections[section].entries.find((entry) => entry.id === id);
}

/**
 * `KS: logistics`, `Language: German (basic conversation)`,
 * `WF: Common Melee Weapons, Small Arms`.
 *
 * The alias comes first. An `INPUT` — the player's chosen subject — follows a
 * colon, as do a familiarity's adders when there is no input. An `OPTION_ALIAS`
 * is parenthesised.
 */
/**
 * Knowledge Skills are written with a single space — "KS: logistics" — where
 * every other skill and disadvantage uses two. Nothing in the rules data
 * distinguishes them, so this follows the exported sheet rather than a rule.
 */
const SINGLE_SPACE_SKILLS = new Set(['KNOWLEDGE_SKILL']);

function separatorFor(skill: Ability): string {
  return SINGLE_SPACE_SKILLS.has(skill.xmlId) ? ': ' : SUBJECT_SEPARATOR;
}

export function skillText(skill: Ability): string {
  const parts: string[] = [skill.alias];
  const input = skill.attributes['INPUT'];
  const detail = input !== undefined && input.length > 0 ? input : skill.adders.map(adderText).join(', ');
  if (detail.length > 0) {
    parts.push(`${separatorFor(skill)}${detail}`);
  }
  const option = skill.attributes['OPTION_ALIAS'];
  if (option !== undefined && option.length > 0) {
    parts.push(` (${option})`);
  }
  return parts.join('');
}

/**
 * A skill shows a roll only if the rules give it one. `Language` and the
 * familiarities define no `FAMILIARITYROLL`, and show no roll on the sheet.
 */
export function skillRoll(
  skill: Ability,
  rule: RuleNode | undefined,
  characteristics: CharacteristicSet,
): string {
  if (rule?.attributes?.['FAMILIARITYROLL'] === undefined || isYes(skill.attributes['FAMILIARITY'])) {
    return '';
  }
  const characteristic = skill.attributes['CHARACTERISTIC'] ?? 'GENERAL';
  const base = characteristics.byId.get(characteristic);
  if (base === undefined) {
    // A skill tied to no characteristic — a Science or Knowledge Skill bought
    // flat — rolls against a fixed number.
    return `${GENERAL_SKILL_ROLL + skill.levels}-`;
  }
  return formatRoll(base.total + skill.levels * 5);
}

export function skillCost(skill: Ability): number {
  const adders = adderTotal(skill.adders);
  const base = skill.baseCost > 0 || adders > 0 ? skill.baseCost : DEFAULT_SKILL_COST;
  return base + adders + skill.levels * SKILL_LEVEL_COST;
}

export function buildSkill(
  skill: Ability,
  system: RuleSystem,
  characteristics: CharacteristicSet,
): RenderedAbility {
  const rawCost = skillCost(skill);
  return {
    source: skill,
    text: skillText(skill),
    roll: skillRoll(skill, ruleFor(system, 'SKILLS', skill.xmlId), characteristics),
    rawCost,
    cost: roundHalfUp(rawCost),
    notes: skill.notes,
  };
}

/**
 * `Combat Luck (6 PD/6 ED)`, `Lightning Reflexes: +4 DEX to act first with All
 * Actions`. Talents and perks share a shape: alias, then whatever detail the
 * item carries.
 */
export function simpleText(ability: Ability): string {
  const parts: string[] = [ability.alias];
  const input = ability.attributes['INPUT'];
  if (input !== undefined && input.length > 0) {
    parts.push(`: ${input}`);
  }
  const option = ability.attributes['OPTION_ALIAS'];
  if (option !== undefined && option.length > 0) {
    parts.push(`: ${option}`);
  }
  const adders = ability.adders.map(adderText);
  if (adders.length > 0) {
    parts.push(` (${adders.join('; ')})`);
  }
  return parts.join('');
}

/**
 * Talents and perks cost a base plus a per-level price that lives in the rules,
 * not the character file: Combat Luck is `LVLCOST="6"`, and Lightning Reflexes
 * is 3 points for every 2 levels.
 */
export function levelledCost(ability: Ability, rule: RuleNode | undefined): number {
  const attributes = rule?.attributes ?? {};
  const perLevel = Number(attributes['LVLCOST'] ?? 0);
  const per = Number(attributes['LVLVAL'] ?? 1);
  const base = ability.baseCost > 0 ? ability.baseCost : Number(attributes['BASECOST'] ?? 0);
  const levels = per > 0 && perLevel > 0 ? (ability.levels * perLevel) / per : 0;
  return base + adderTotal(ability.adders) + levels;
}

/**
 * `Psychological Limitation: uses powers sparingly (Very Common; Strong)`.
 *
 * A disadvantage's detail is its input, and its adders — how common, how
 * strongly it bites — are parenthesised and separated with semicolons.
 */
/**
 * `Psychological Limitation: uses powers sparingly (Very Common; Strong)`.
 *
 * The parentheses are not added here. HERO Designer stores them inside the
 * option text itself — a Distinctive Feature's concealability reads
 * `"(Easily Concealed"`, opening a group that later options continue and the
 * closing bracket finishes. So the options are simply joined, an option that
 * opens a bracket starting a new group rather than continuing the list.
 */
export function disadvantageText(disadvantage: Ability, rule?: RuleNode): string {
  let text = disadvantage.alias;

  // A modifier that carries option text qualifies the disadvantage itself:
  // a Vulnerability's multiplier turns "high energy radiation" into
  // "2 x STUN high energy radiation".
  const qualifiers = disadvantage.modifiers
    .map((modifier) => modifier.attributes['OPTION_ALIAS'] ?? '')
    .filter((option) => option.length > 0);
  const input = [...qualifiers, disadvantage.attributes['INPUT'] ?? '']
    .filter((part) => part.length > 0)
    .join(' ');
  if (input.length > 0) {
    text += `${SUBJECT_SEPARATOR}${input}`;
  }

  // The first option follows the subject with a comma, unless the rules give
  // the disadvantage its own separator. Only four disadvantages do, Hunted
  // among them, and they read "Hunted: Overwatch 8-" rather than
  // "Reputation: \"...\", 11-".
  const firstSeparator = rule?.attributes?.['ADDERSEPARATOR'] === undefined ? ', ' : ' ';

  let open = false;
  disadvantage.adders.filter(isShown).forEach((adder, index) => {
    const option = adderOption(adder);
    if (option.length === 0) {
      return;
    }
    const startsGroup = option.startsWith('(');
    text += startsGroup ? ` ${option}` : `${index === 0 ? firstSeparator : '; '}${option}`;
    open ||= startsGroup;
  });

  return open ? `${text})` : text;
}

/** An option's own wording, falling back to the adder's name. */
function adderOption(adder: Ability): string {
  const option = adder.attributes['OPTION_ALIAS'];
  return option !== undefined && option.length > 0 ? option : adder.alias;
}

function isShown(adder: Ability): boolean {
  return adder.attributes['SHOWALIAS'] === undefined || isYes(adder.attributes['SHOWALIAS']);
}

export function buildDisadvantage(disadvantage: Ability, rule?: RuleNode): RenderedAbility {
  // Modifiers multiply, as they do for powers: a Vulnerability's "2 x STUN"
  // multiplier is +1, which turns a 5-point disadvantage into a 10-point one.
  const base = disadvantage.baseCost + adderTotal(disadvantage.adders);
  const rawCost = base * (1 + advantageTotal(disadvantage.modifiers));
  return {
    source: disadvantage,
    text: disadvantageText(disadvantage, rule),
    roll: '',
    rawCost,
    cost: roundHalfUp(rawCost),
    notes: disadvantage.notes,
  };
}

export function buildSimple(ability: Ability, rule?: RuleNode): RenderedAbility {
  const rawCost = levelledCost(ability, rule);
  return {
    source: ability,
    text: simpleText(ability),
    roll: '',
    rawCost,
    cost: roundHalfUp(rawCost),
    notes: ability.notes,
  };
}

export interface RenderedManeuver {
  readonly source: Ability;
  readonly name: string;
  readonly phase: string;
  readonly ocv: string;
  readonly dcv: string;
  readonly effect: string;
  readonly cost: number;
}

/**
 * Martial maneuvers print their columns from the character file, except that an
 * effect carries placeholders for damage the character rolls: a maneuver worth
 * two damage classes reads `[STRDC] to Disarm`, which for a STR 18 character
 * becomes `28 STR to Disarm`.
 */
export function buildManeuver(maneuver: Ability, strength = 0): RenderedManeuver {
  const attributes = maneuver.attributes;
  const damage = (isYes(attributes['ADDSTR']) ? strength : 0) + Number(attributes['DC'] ?? 0) * 5;
  const effect = (attributes['EFFECT'] ?? '')
    .replaceAll('[STRDC]', `${damage} STR`)
    .replaceAll('[NORMALDC]', formatDice(damage))
    .replaceAll('[KILLINGDC]', `${formatDice(damage)}K`);
  return {
    source: maneuver,
    name: maneuver.alias,
    phase: attributes['PHASE'] ?? '',
    ocv: attributes['OCV'] ?? '',
    dcv: attributes['DCV'] ?? '',
    effect,
    cost: roundHalfUp(maneuver.baseCost),
  };
}

/** Totals are summed from exact costs and rounded once. */
export function totalCost(abilities: readonly RenderedAbility[]): number {
  return roundHalfUp(abilities.reduce((sum, ability) => sum + ability.rawCost, 0));
}
