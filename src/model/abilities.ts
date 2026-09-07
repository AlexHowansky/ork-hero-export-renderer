import type { Ability } from '../hdc/types.ts';
import { isYes } from '../hdc/parse.ts';
import type { RuleNode, RuleSystem, SectionName } from '../rules/types.ts';
import { formatDice, formatRoll, roundHalfUp } from './numbers.ts';
import {
  activeCost,
  adderCost,
  adderRulesFrom,
  adderString,
  adderText,
  adderTotal,
  advantageTotal,
  modifierTail,
  realCost,
} from './modifiers.ts';
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
  /**
   * True for a heading the player groups other entries under. A list is not an
   * ability: it prints its name and leaves its cost column empty.
   */
  readonly isList: boolean;
}

/** The element name a list heading is stored under, in any section. */
export const LIST_ELEMENT = 'LIST';

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

/** Skills bought as levels, which read `+3 with All Combat` and price by option. */
const LEVEL_SKILLS = new Set([
  'COMBAT_LEVELS', 'MENTAL_COMBAT_LEVELS', 'SKILL_LEVELS', 'PENALTY_SKILL_LEVELS',
]);

export function skillText(skill: Ability, rule?: RuleNode): string {
  const option = skill.attributes['OPTION_ALIAS'] ?? '';
  if (skill.xmlId === 'PENALTY_SKILL_LEVELS') {
    // A penalty skill level says what it offsets and where it applies:
    // `Penalty Skill Levels:  +4 vs. Range Modifier with a tight group of
    // attacks (grapnel)`.
    const levels = `${skill.levels >= 0 ? '+' : ''}${skill.levels}`;
    return `${skill.alias}${SUBJECT_SEPARATOR}${levels} vs. ${skill.attributes['INPUT'] ?? ''} with ${option}`;
  }
  if (LEVEL_SKILLS.has(skill.xmlId)) {
    return `${skill.levels >= 0 ? '+' : ''}${skill.levels} ${option}`.trim();
  }

  const parts: string[] = [skill.alias];
  const input = skill.attributes['INPUT'];
  const adders = adderString(skill.adders, adderRulesFrom(rule));
  if (input !== undefined && input.length > 0) {
    parts.push(`${separatorFor(skill)}${input}`);
  } else if (adders.length > 0) {
    // A skill that rolls brackets its subject — `Navigation (Land)` — where a
    // familiarity, which never rolls, lists them after a colon instead.
    parts.push(rolls(rule) ? ` (${adders})` : `${separatorFor(skill)}${adders}`);
  }
  if (option.length > 0) {
    parts.push(` (${option})`);
  }
  return parts.join('');
}

function rolls(rule: RuleNode | undefined): boolean {
  return rule?.attributes?.['FAMILIARITYROLL'] !== undefined;
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
  const familiarityRoll = rule?.attributes?.['FAMILIARITYROLL'];
  if (familiarityRoll === undefined) {
    return '';
  }
  // A skill taken only as a familiarity rolls against the flat number the rules
  // give it, however good the characteristic behind it is.
  if (isYes(skill.attributes['FAMILIARITY'])) {
    return `${familiarityRoll}-`;
  }
  const characteristic = skill.attributes['CHARACTERISTIC'] ?? 'GENERAL';
  const base = characteristics.byId.get(characteristic);
  if (base === undefined) {
    // A skill tied to no characteristic — a Science or Knowledge Skill bought
    // flat — rolls against a fixed number.
    return `${GENERAL_SKILL_ROLL + skill.levels}-`;
  }
  const roll = formatRoll(base.total + skill.levels * 5);
  if (base.primary === base.total) {
    return roll;
  }
  // The characteristic behind the skill is not all always on, so the skill
  // rolls two ways and the better one follows in brackets.
  return `${formatRoll(base.primary + skill.levels * 5)} (${roll})`;
}

/**
 * A skill's price: whatever the character file says, plus its adders, plus its
 * levels. Levels are priced by what they apply to — a combat skill level with
 * every attack is 8 points where one with a single attack is 2 — so the option
 * the player chose is consulted before the skill's own rate.
 */
export function skillCost(skill: Ability, rule?: RuleNode): number {
  const adders = adderTotal(skill.adders, adderRulesFrom(rule));
  const option = rule?.children?.find((child) => child.id === skill.attributes['OPTIONID']);
  const perLevel = Number(
    skill.attributes['LVLCOST'] ?? option?.attributes?.['LVLCOST'] ?? rule?.attributes?.['LVLCOST'] ?? SKILL_LEVEL_COST,
  );
  const per = Number(skill.attributes['LVLVAL'] ?? option?.attributes?.['LVLVAL'] ?? rule?.attributes?.['LVLVAL'] ?? 1) || 1;
  const base = LEVEL_SKILLS.has(skill.xmlId) || skill.baseCost > 0 || adders > 0
    ? skill.baseCost
    : DEFAULT_SKILL_COST;
  return base + adders + (skill.levels * perLevel) / per;
}

export function buildSkill(
  skill: Ability,
  system: RuleSystem,
  characteristics: CharacteristicSet,
): RenderedAbility {
  if (skill.element === LIST_ELEMENT) {
    return listHeading(skill);
  }
  const rule = ruleFor(system, 'SKILLS', skill.xmlId);
  const priced = withModifiers(skill, system, skillCost(skill, rule));
  return {
    source: skill,
    text: skillText(skill, rule) + priced.tail,
    roll: skillRoll(skill, rule, characteristics),
    rawCost: priced.rawCost,
    cost: roundHalfUp(priced.rawCost),
    notes: skill.notes,
    isList: false,
  };
}

/**
 * What modifiers do to an ability that is not a power.
 *
 * A skill or talent can be bought with advantages and limitations just as a
 * power can, and then prices and reads the same way: the base cost becomes an
 * active cost, the limitations divide it, and the description grows a tail.
 */
function withModifiers(
  ability: Ability,
  system: RuleSystem,
  base: number,
): { readonly rawCost: number; readonly tail: string } {
  if (ability.modifiers.length === 0) {
    return { rawCost: base, tail: '' };
  }
  const active = activeCost(base, ability.modifiers, system);
  const real = realCost(active, ability.modifiers, system);
  return {
    rawCost: real,
    tail: modifierTail(ability, { system }, { total: base, active, real }),
  };
}

/**
 * `Combat Luck (6 PD/6 ED)`, `Lightning Reflexes: +4 DEX to act first with All
 * Actions`. Talents and perks share a shape: alias, then whatever detail the
 * item carries.
 */
export function simpleText(ability: Ability): string {
  if (ability.xmlId === 'REPUTATION') {
    return reputationText(ability);
  }
  const parts: string[] = [ability.alias];
  const input = ability.attributes['INPUT'];
  if (input !== undefined && input.length > 0) {
    parts.push(`: ${input}`);
  }
  const option = ability.attributes['OPTION_ALIAS'];
  if (option !== undefined && option.length > 0) {
    parts.push(`: ${option}`);
  }
  const adders = ability.adders.map((adder) => adderText(adder));
  if (adders.length > 0) {
    parts.push(` (${adders.join('; ')})`);
  }
  return parts.join('');
}

/**
 * `Reputation:  rescuer, healer (A large group) 11-, +1/+1d6`.
 *
 * A positive Reputation is described by two adders that ask not to be listed as
 * adders: how widely the character is known, which is bracketed, and how often
 * they are recognised, which follows it. The levels bought are what the
 * reputation is worth in play — a bonus to interaction rolls and to PRE
 * attacks alike.
 */
function reputationText(perk: Ability): string {
  const option = (xmlId: string): string =>
    perk.adders.find((adder) => adder.xmlId === xmlId)?.attributes['OPTION_ALIAS'] ?? '';
  const parts = [perk.alias, SUBJECT_SEPARATOR, perk.attributes['INPUT'] ?? ''];
  const known = option('HOWWIDE');
  if (known.length > 0) {
    parts.push(` (${known})`);
  }
  const recognised = option('HOWWELL');
  if (recognised.length > 0) {
    parts.push(` ${recognised}`);
  }
  if (perk.levels > 0) {
    parts.push(`, +${perk.levels}/+${perk.levels}d6`);
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
  // A Vehicles & Bases perk is not bought in levels but in the points the
  // vehicle itself is worth, at a point of the character's per five of it.
  const units = Number(ability.attributes['BASEPOINTS'] ?? ability.levels);
  const levels = per > 0 && perLevel > 0 ? (units * perLevel) / per : 0;
  return base + adderTotal(ability.adders, adderRulesFrom(rule)) + levels;
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
  // "Reputation: \"...\", 11-". A disadvantage with no subject of its own —
  // "Money:  Poor" — introduces its first option the way a subject would.
  const firstSeparator = input.length === 0
    ? SUBJECT_SEPARATOR
    : rule?.attributes?.['ADDERSEPARATOR'] === undefined ? ', ' : ' ';

  let open = false;
  // The dearest option comes first: a Hunted reads "(Mo Pow; NCI; Capture)"
  // however the character file happens to store them.
  sortedAdders(disadvantage.adders.filter(isShown), rule).forEach((adder, index) => {
    const option = adderOption(adder);
    if (option.length === 0) {
      return;
    }
    const startsGroup = option.startsWith('(');
    if (startsGroup) {
      // A second bracket does not open a second group: it continues the one
      // already open, as another option separated from the first.
      text += open ? `;  ${option.slice(1)}` : ` ${option}`;
      open = true;
    } else {
      text += `${index === 0 ? firstSeparator : '; '}${option}`;
    }
  });

  return open ? `${text})` : text;
}

/**
 * Options in the order the sheet lists them.
 *
 * What comes before the bracket stays as the character file has it — a Hunted
 * leads with the roll it appears on. Inside the bracket the dearest comes
 * first, which is how "(Mo Pow; NCI; Capture)" puts the 5-point NCI ahead of
 * the free Capture whichever way round they are stored.
 */
function sortedAdders(adders: readonly Ability[], rule?: RuleNode): Ability[] {
  const opens = adders.findIndex((adder) => adderOption(adder).startsWith('('));
  if (opens < 0) {
    return [...adders];
  }
  const rules = adderRulesFrom(rule);
  const inside = adders
    .slice(opens + 1)
    .map((adder, index) => ({ adder, index, cost: adderCost(adder, rules(adder)) }))
    .sort((a, b) => b.cost - a.cost || a.index - b.index)
    .map((entry) => entry.adder);
  return [...adders.slice(0, opens + 1), ...inside];
}

/** An option's own wording, falling back to the adder's name. */
function adderOption(adder: Ability): string {
  const option = adder.attributes['OPTION_ALIAS'];
  return option !== undefined && option.length > 0 ? option : adder.alias;
}

function isShown(adder: Ability): boolean {
  return adder.attributes['SHOWALIAS'] === undefined || isYes(adder.attributes['SHOWALIAS']);
}

export function buildDisadvantage(
  disadvantage: Ability,
  system: RuleSystem,
  rule?: RuleNode,
): RenderedAbility {
  if (disadvantage.element === LIST_ELEMENT) {
    return listHeading(disadvantage);
  }
  // Modifiers multiply, as they do for powers: a Vulnerability's "2 x STUN"
  // multiplier is +1, which turns a 5-point disadvantage into a 10-point one.
  const base = disadvantage.baseCost + adderTotal(disadvantage.adders, adderRulesFrom(rule));
  const rawCost = base * (1 + advantageTotal(disadvantage.modifiers, system));
  return {
    source: disadvantage,
    text: disadvantageText(disadvantage, rule),
    roll: '',
    rawCost,
    cost: roundHalfUp(rawCost),
    notes: disadvantage.notes,
    isList: false,
  };
}

/** A list heading: its name, no roll, no cost. */
export function listHeading(ability: Ability): RenderedAbility {
  return {
    source: ability,
    text: ability.alias,
    roll: '',
    rawCost: 0,
    cost: 0,
    notes: ability.notes,
    isList: true,
  };
}

export function buildSimple(ability: Ability, system: RuleSystem, rule?: RuleNode): RenderedAbility {
  if (ability.element === LIST_ELEMENT) {
    return listHeading(ability);
  }
  const priced = withModifiers(ability, system, levelledCost(ability, rule));
  return {
    source: ability,
    text: simpleText(ability) + priced.tail,
    roll: '',
    rawCost: priced.rawCost,
    cost: roundHalfUp(priced.rawCost),
    notes: ability.notes,
    isList: false,
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
