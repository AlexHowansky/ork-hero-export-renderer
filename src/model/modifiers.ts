import type { Ability } from '../hdc/types.ts';
import type { RuleNode, RuleSystem } from '../rules/types.ts';
import { formatSigned, roundHalfUp, roundHalfDown, roundUp } from './numbers.ts';

/**
 * Adders, advantages and limitations: what they cost and how they read.
 *
 * A power's *active cost* is its total cost multiplied by one plus the sum of
 * its advantages; its *real cost* is the active cost divided by one plus the
 * absolute total of its limitations. Adders are part of the total, so they are
 * multiplied along with everything else.
 *
 * Every step rounds with `roundHalfDown`, and a modifier's own value is settled
 * to the nearest quarter before it is used. The order matters: rounding once at
 * the end gives a different answer.
 */

export interface ModifierText {
  readonly value: number;
  readonly text: string;
}

/** What a modifier needs to know about the world outside itself. */
export interface ModifierEnv {
  readonly system: RuleSystem;
  /**
   * The power's active cost with one advantage left out. Area Of Effect sizes
   * its area from what the power would cost without it.
   */
  readonly activeCostExcluding?: ((xmlId: string) => number) | undefined;
  /** What a Linked modifier's target is called on the sheet. */
  readonly linkTarget?: ((id: string) => string | undefined) | undefined;
}

export function ruleForModifier(system: RuleSystem, xmlId: string): RuleNode | undefined {
  return system.sections.MODIFIERS.entries.find((entry) => entry.id === xmlId);
}

/** The rules node for the option a modifier or adder has selected. */
export function optionRule(rule: RuleNode | undefined, optionId: string | undefined): RuleNode | undefined {
  if (rule === undefined || optionId === undefined) {
    return undefined;
  }
  return rule.children?.find((child) => child.id === optionId);
}

/**
 * An option is written into the description unless the rules say otherwise:
 * `Costs Endurance (Only Costs END to Activate; -1/4)` prints its option, while
 * the every-phase option is marked `DISPLAYINSTRING="No"` and prints as a bare
 * `Costs Endurance (-1/2)`.
 */
function optionShown(rule: RuleNode | undefined): boolean {
  return rule?.attributes?.['DISPLAYINSTRING'] !== 'No';
}

function shown(ability: Ability): boolean {
  return ability.attributes['DISPLAYINSTRING'] !== 'No';
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Levelled prices live on the character file when it has them, in the rules otherwise. */
function levelPrice(ability: Ability, rule: RuleNode | undefined): { value: number; cost: number } {
  return {
    value: num(ability.attributes['LVLVAL'] ?? rule?.attributes?.['LVLVAL'], 0),
    cost: num(ability.attributes['LVLCOST'] ?? rule?.attributes?.['LVLCOST'], 0),
  };
}

// ---------------------------------------------------------------- adders

/** `Discriminatory`, `+7 DEF`, `Mobile Perception Point (…):  +1`. */
export function adderCost(adder: Ability, rule?: RuleNode): number {
  const { value, cost } = levelPrice(adder, rule);
  let total = adder.baseCost + (value !== 0 ? (adder.levels / value) * cost : 0);
  const min = rule?.attributes?.['MINCOST'];
  const max = rule?.attributes?.['MAXCOST'];
  if (min !== undefined && total < Number(min) && total < 0) {
    total = Number(min);
  } else if (max !== undefined && total > Number(max) && total > 0) {
    total = Number(max);
  }
  return total;
}

export function adderTotal(adders: readonly Ability[], rules?: AdderRules): number {
  return adders.reduce((sum, adder) => sum + adderCost(adder, rules?.(adder)), 0);
}

/** Finds the rules node for one of a parent's adders. */
export type AdderRules = (adder: Ability) => RuleNode | undefined;

export function adderRulesFrom(parent: RuleNode | undefined): AdderRules {
  return (adder) => parent?.children?.find((child) => child.id === adder.xmlId);
}

/**
 * How one adder reads: its name, then its option and input, then any adders of
 * its own, then `:  +3` for a levelled adder — unless the rules write the level
 * into the name themselves with a `[LVL]` placeholder.
 */
export function adderText(adder: Ability, rule?: RuleNode): string {
  const parts: string[] = [];
  if (adder.attributes['SHOWALIAS'] !== 'No') {
    parts.push(adder.alias);
  }
  const option = adder.attributes['OPTION_ALIAS'];
  if (option !== undefined && option.length > 0) {
    parts.push(option);
  }
  const input = adder.attributes['INPUT'];
  if (input !== undefined && input.length > 0) {
    parts.push(input);
  }
  let text = parts.filter((part) => part.length > 0).join(' ').trim();

  const nested = adderString(adder.adders, adderRulesFrom(rule));
  if (nested.length > 0) {
    text = text.length > 0 ? `${text}, ${nested}` : nested;
  }
  // A levelled adder says how many levels were bought — unless the rules write
  // the count into its name themselves, as `-[LVL]` does for `-3 DCV`.
  const display = rule?.attributes?.['DISPLAY'] ?? '';
  if (adder.levels > 0 && display.replace('[LVL]', String(adder.levels)) !== adder.alias) {
    text += `:  +${adder.levels}`;
  }
  return text;
}

/**
 * The adder list, as HERO Designer assembles it: adders that carry adders of
 * their own come first, then the plain ones, each group in alphabetical order
 * rather than the order the character file lists them.
 */
export function adderString(
  adders: readonly Ability[],
  rules?: AdderRules,
  hidden: ReadonlySet<string> = new Set(),
  separator = ', ',
): string {
  const grouped: string[] = [];
  const plain: string[] = [];
  for (const adder of adders) {
    if (hidden.has(adder.xmlId) || !shown(adder)) {
      continue;
    }
    const rule = rules?.(adder);
    const text = adderText(adder, rule).trim();
    if (text.length === 0) {
      continue;
    }
    const hasOwnAdders = (rule?.children ?? []).some((child) => child.element === 'ADDER');
    (hasOwnAdders || adder.attributes['GROUP'] === 'Yes' ? grouped : plain).push(text);
  }
  const byName = (a: string, b: string) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
  return [...grouped.sort(byName), ...plain.sort(byName)].join(separator);
}

// ------------------------------------------------------------- modifiers

/**
 * A modifier's value, settled to the nearest quarter.
 *
 * Adders add to it, a modifier of its own multiplies it — "Side Effect occurs
 * automatically" is a `+1` nested under a `-1/2` Side Effects, and doubles it
 * to `-1`.
 */
export function modifierValue(modifier: Ability, system: RuleSystem): number {
  const rule = ruleForModifier(system, modifier.xmlId);
  let base = modifier.baseCost + adderTotal(modifier.adders, adderRulesFrom(rule));

  const { value, cost } = levelPrice(modifier, rule);
  if (value > 0) {
    // Explosion charges from its first level rather than from zero.
    const start = modifier.xmlId === 'EXPLOSION' ? num(rule?.attributes?.['MINVAL'], 0) : 0;
    base += ((modifier.levels - start) / value) * cost;
  }

  let up = 0;
  let down = 0;
  for (const nested of modifier.modifiers) {
    const nestedValue = modifierValue(nested, system);
    if (nestedValue > 0) {
      up += nestedValue;
    } else if (nestedValue < 0) {
      down += Math.abs(nestedValue);
    }
  }

  const scaled = (base * (1 + up)) / (1 + down);
  const sign = scaled < 0 ? -1 : 1;
  const settled = (sign * roundHalfUp(Math.abs(scaled) * 4)) / 4;

  const min = rule?.attributes?.['MINCOST'];
  const max = rule?.attributes?.['MAXCOST'];
  if (min !== undefined && settled < Number(min)) {
    return Number(min);
  }
  if (max !== undefined && settled > Number(max)) {
    return Number(max);
  }
  return settled;
}

/**
 * Modifiers are listed cheapest first, keeping the character file's order
 * within a tie — which is how `Reduced Endurance` comes before
 * `Affects Desolidified` even though both are +1/4.
 */
export function sortedModifiers(modifiers: readonly Ability[], system: RuleSystem): Ability[] {
  return modifiers
    .map((modifier, index) => ({ modifier, index, value: modifierValue(modifier, system) }))
    .sort((a, b) => a.value - b.value || a.index - b.index)
    .map((entry) => entry.modifier);
}

/** A modifier worth nothing still reads as an advantage, as `STUN Only (+0)` does. */
export function advantages(modifiers: readonly Ability[], system: RuleSystem): Ability[] {
  return sortedModifiers(modifiers, system).filter((modifier) => modifierValue(modifier, system) >= 0);
}

export function limitations(modifiers: readonly Ability[], system: RuleSystem): Ability[] {
  return sortedModifiers(modifiers, system).filter((modifier) => modifierValue(modifier, system) < 0);
}

/** Only modifiers worth something multiply the cost; a `+0` leaves it alone. */
export function advantageTotal(modifiers: readonly Ability[], system: RuleSystem): number {
  return modifiers.reduce((sum, modifier) => sum + Math.max(0, modifierValue(modifier, system)), 0);
}

/** Limitations are quoted as negatives but divide as positives. */
export function limitationTotal(modifiers: readonly Ability[], system: RuleSystem): number {
  return modifiers.reduce((sum, modifier) => sum + Math.max(0, -modifierValue(modifier, system)), 0);
}

/** `total * (1 + advantages)`, rounded once, as HERO Designer does it. */
export function activeCost(
  totalCost: number,
  modifiers: readonly Ability[],
  system: RuleSystem,
): number {
  const total = advantageTotal(modifiers, system);
  const raw = totalCost * (1 + total);
  if (!modifiers.some((modifier) => modifierValue(modifier, system) > 0)) {
    return raw;
  }
  const rounded = roundHalfDown(raw);
  return totalCost > 0 && rounded < 1 ? 1 : rounded;
}

export function realCost(
  active: number,
  modifiers: readonly Ability[],
  system: RuleSystem,
): number {
  const total = limitationTotal(modifiers, system);
  const raw = active / (1 + total);
  return total > 0 ? roundHalfDown(raw) : raw;
}

/**
 * How one modifier reads.
 *
 * The general shape is `Name Option (detail; +1/2)`: the name, then whatever
 * qualifies it, then a bracket holding the option (when the rules put it
 * there), the modifier's own adders, the player's comment, and the value. A
 * handful of modifiers replace parts of that, and each is called out below.
 */
/**
 * Where a modifier puts the option the player chose.
 *
 * Most modifiers write it straight after their name — `Limited Power Power
 * loses about a fourth of its effectiveness (…)`. Some open their bracket at
 * the option instead, some replace their own name with it, and some do not
 * print it at all. Which does what is not in the rules data; it is decided by
 * the class HERO Designer builds for each modifier, so this is a transcription
 * of the ones the fixtures exercise.
 */
const OPTION_REPLACES_NAME = new Set(['FOCUS', 'RANGED', 'UOO']);
const OPTION_IN_BRACKET = new Set(['REDUCEDEND', 'BOECV', 'COSTSEND', 'EXTRATIME', 'INVISIBLE']);
const OPTION_HIDDEN = new Set([
  'ARMORPIERCING', 'DOUBLEKB', 'HARDENED', 'PENETRATING', 'REQUIRESASKILLROLL',
  'RESTRAINABLE', 'SEMIARMORPIERCING', 'SIDEEFFECTS',
]);
/** Extra Time separates the parts of its bracket with commas, not semicolons. */
const COMMA_BRACKET = new Set(['EXTRATIME']);
/** Charges that go on working after they are spent, for a stated time. */
export const CONTINUING_ADDER = 'CONTINUING';

/**
 * How one modifier reads.
 *
 * The general shape is `Name Option (detail; +1/2)`: the name, then whatever
 * qualifies it, then a bracket holding the modifier's own adders, the player's
 * comment, and the value. A bracket the name has already opened is continued
 * rather than opened again, which is how `Reduced Endurance (1/2 END` ends up
 * as `Reduced Endurance (1/2 END; +1/4)`.
 */
export function modifierText(modifier: Ability, env: ModifierEnv): ModifierText {
  const value = modifierValue(modifier, env.system);
  const rule = ruleForModifier(env.system, modifier.xmlId);
  const option = optionRule(rule, modifier.attributes['OPTIONID']);
  const optionAlias = modifier.attributes['OPTION_ALIAS'] ?? '';
  const comments = modifier.attributes['COMMENTS'] ?? '';

  const bracket: string[] = [];
  // Only leading space is dropped: a modifier whose name ends in one — "Requires
  // A DEX Roll " — really does print two spaces before its value.
  let head = modifier.alias.trimStart();

  if (modifier.xmlId === 'UOO') {
    // `Usable Simultaneously (up to 4 people at once; +3/4)`: the option names
    // the modifier and an adder doubles how many people it reaches.
    head = optionAlias.length > 0 ? optionAlias : head;
    const targets = modifier.adders.find((adder) => adder.xmlId === 'TARGETS');
    if (targets !== undefined) {
      bracket.push(`up to ${2 * 2 ** targets.levels} people at once`);
    }
  } else if (OPTION_REPLACES_NAME.has(modifier.xmlId)) {
    head = optionAlias.length > 0 ? optionAlias : head;
  } else if (modifier.xmlId === 'CHARGES') {
    // The number of charges comes before the word: `6 Charges (-3/4)`. Charges
    // that keep working once spent say for how long, in place of the adder that
    // records it: `4 Continuing Charges lasting 1 Minute each`.
    const continuing = modifier.adders.find((adder) => adder.xmlId === CONTINUING_ADDER);
    head = continuing === undefined
      ? `${optionAlias} ${head}`.trim()
      : `${optionAlias} ${continuing.alias} ${head} lasting ${continuing.attributes['OPTION_ALIAS'] ?? ''} each`.trim();
  } else if (modifier.xmlId === 'AOE') {
    bracket.push(areaOfEffect(modifier, optionAlias, env));
  } else if (modifier.xmlId === 'DIFFICULTTODISPEL') {
    // The bracket says what the levels bought, as a power of two.
    bracket.push(`x${num(rule?.attributes?.['LVLPOWER'], 2) ** modifier.levels} Active Points`);
  } else if (modifier.xmlId === 'LINKED') {
    bracket.push(env.linkTarget?.(modifier.attributes['LINKED_ID'] ?? '') ?? '???');
  } else if (modifier.xmlId === 'EXPLOSION') {
    // Explosion's default shape is not worth naming.
    if (optionAlias.length > 0 && optionAlias !== 'Normal (Radius)') {
      head = `${head} (${optionAlias}`;
    }
  } else if (optionAlias.length > 0 && optionAlias !== modifier.alias && optionShown(option) && !OPTION_HIDDEN.has(modifier.xmlId)) {
    head = OPTION_IN_BRACKET.has(modifier.xmlId) ? `${head} (${optionAlias}` : `${head} ${optionAlias}`.trim();
  }

  for (const nested of modifier.modifiers) {
    head = `${head}, ${nested.alias}`;
  }

  for (const adder of modifier.adders) {
    // A Continuing adder has already been written into the modifier's name.
    if (!shown(adder) || (modifier.xmlId === 'CHARGES' && adder.xmlId === CONTINUING_ADDER)) {
      continue;
    }
    const text = adderText(adder, adderRulesFrom(rule)(adder)).trim();
    if (text.length > 0) {
      bracket.push(text);
    }
  }
  if (comments.length > 0) {
    bracket.push(comments);
  }

  // A bracket the name already opened is continued, not opened again.
  const open = head.split('(').length - head.split(')').length;
  const inner = COMMA_BRACKET.has(modifier.xmlId) ? ', ' : '; ';
  const separator = open > 0 ? inner : ' (';
  const close = ')'.repeat(Math.max(1, open));
  return { value, text: `${head}${separator}${[...bracket, formatSigned(value)].join(inner)}${close}` };
}

/**
 * The area an Area Of Effect covers: one inch of radius per ten active points
 * the power would cost without the advantage, doubled for each `x2 Radius`
 * adder, and never smaller than a single inch.
 */
function areaOfEffect(modifier: Ability, optionAlias: string, env: ModifierEnv): string {
  const doubling = modifier.adders.find((adder) => adder.xmlId === 'DOUBLEAREA');
  const factor = 2 ** (doubling?.levels ?? 0);
  if (modifier.attributes['OPTIONID'] === 'HEX' && factor <= 1) {
    return 'One Hex';
  }
  const points = env.activeCostExcluding?.('AOE') ?? 0;
  const radius = Math.max(1, roundHalfUp(factor * Math.max(1, roundHalfUp(points / 10))));
  return `${radius}" ${optionAlias}`;
}

/** `(75 Active Points)`, omitted when there is nothing to say. */
export function activePointsNote(active: number, hasModifiers: boolean): string {
  return hasModifiers ? ` (${roundHalfUp(active)} Active Points)` : '';
}

/** What a description's modifier tail needs to know about the prices. */
export interface Costs {
  /** The item's own price plus its adders, before any modifier. */
  readonly total: number;
  readonly active: number;
  readonly real: number;
}

/**
 * The modifier tail: advantages, then the active-point note, then limitations.
 * The first limitation is introduced with a semicolon and the rest with commas.
 *
 * Powers, skills, talents and perks all read this way — a combat skill level
 * bought in a suit prints `+4 with DCV (20 Active Points); OIF (suit; -1/2)`
 * exactly as a power would.
 */
export function modifierTail(ability: Ability, env: ModifierEnv, costs: Costs): string {
  const sorted = sortedModifiers(ability.modifiers, env.system);
  let text = '';
  for (const modifier of sorted.filter((entry) => modifierValue(entry, env.system) >= 0)) {
    text += `, ${modifierText(modifier, env).text}`;
  }
  if (
    ability.attributes['SHOW_ACTIVE_COST'] !== 'No' &&
    (costs.active !== costs.total || costs.real !== costs.total)
  ) {
    text += ` (${roundUp(costs.active)} Active Points)`;
  }
  let count = 0;
  for (const modifier of sorted.filter((entry) => modifierValue(entry, env.system) < 0)) {
    text += `${++count === 1 ? '; ' : ', '}${modifierText(modifier, env).text}`;
  }
  return text;
}
