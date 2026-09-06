import type { Ability } from '../hdc/types.ts';
import type { RuleNode, RuleSystem } from '../rules/types.ts';
import { HeroError } from '../util/errors.ts';
import { formatDice, formatInches, roundDown, roundHalfUp } from './numbers.ts';
import {
  activeCost,
  adderText,
  advantages,
  limitations,
  modifierText,
  realCost,
} from './modifiers.ts';

/**
 * Powers, and the text that describes them.
 *
 * A power's description is assembled in a fixed order:
 *
 *   base text, adders, advantages (N Active Points); limitations
 *
 * with advantages before the active-point note and limitations after it, and
 * both listed cheapest first.
 */

export interface RenderedPower {
  readonly source: Ability;
  readonly text: string;
  readonly basePoints: number;
  readonly active: number;
  readonly real: number;
  /** `75`, or `7u` for a slot in a multipower. */
  readonly cost: string;
  readonly end: string;
  readonly notes: string;
  /** True for the framework itself rather than one of its slots. */
  readonly isFramework: boolean;
}

/** Powers whose levels are points of defence, printed as `(5 points)`. */
const POINT_DEFENCES = new Set(['POWERDEFENSE', 'FLASHDEFENSE', 'MENTALDEFENSE', 'LACKOFWEAKNESS']);
/** Powers measured in inches. */
const DISTANCE_POWERS = new Set(['STRETCHING', 'RUNNING', 'SWIMMING', 'LEAPING', 'FLIGHT', 'TELEPORTATION']);
/** Powers measured in dice of effect. */
const DICE_POWERS = new Set([
  'ENERGYBLAST', 'HEALING', 'DRAIN', 'AID', 'TRANSFER', 'EGOATTACK', 'RKA', 'HKA',
  'KILLINGATTACK', 'HANDTOHANDATTACK', 'ENTANGLE', 'FLASH', 'TELEPATHY', 'MINDCONTROL',
]);
/** Powers that cover an area and describe their effects inside it. */
const AREA_POWERS = new Set(['CHANGEENVIRONMENT']);
/** Powers that name the characteristic they act on in their description. */
const ADJUSTMENT_POWERS = new Set(['HEALING', 'DRAIN', 'AID', 'TRANSFER', 'SUCCOR', 'ABSORPTION']);
/** Elements that are frameworks rather than powers in their own right. */
const FRAMEWORKS = new Set(['MULTIPOWER', 'ELEMENTAL_CONTROL', 'VPP']);

export interface BuildPowerOptions {
  /** When false, an unrecognised power is described generically instead of failing. */
  readonly strict?: boolean;
}

export function buildPower(
  power: Ability,
  system: RuleSystem,
  options: BuildPowerOptions = {},
): RenderedPower {
  const rule = system.sections.POWERS.entries.find((entry) => entry.id === power.xmlId);
  const isFramework = FRAMEWORKS.has(power.element);

  const basePoints = basePointsOf(power, rule);
  const active = activeCost(basePoints, power.modifiers);
  const real = realCost(basePoints, power.modifiers);

  return {
    source: power,
    text: powerText(power, rule, basePoints, options),
    basePoints,
    active,
    real,
    cost: isFramework ? String(roundHalfUp(basePoints)) : slotCost(power, real),
    end: enduranceOf(power, active, isFramework),
    notes: power.notes,
    isFramework,
  };
}

/** Levels times the per-level price from the rules, plus any adders. */
export function basePointsOf(power: Ability, rule: RuleNode | undefined): number {
  const adders = power.adders.reduce((sum, adder) => sum + adderCost(adder, rule), 0);
  if (power.baseCost > 0) {
    return power.baseCost + adders;
  }
  const attributes = rule?.attributes ?? {};
  const perLevel = Number(attributes['LVLCOST'] ?? 0);
  const per = Number(attributes['LVLVAL'] ?? 1) || 1;
  return (power.levels * perLevel) / per + adders;
}

/**
 * What an adder on a power is worth.
 *
 * The character file often records no cost, leaving it to the rules — Change
 * Environment's `-3 DCV` says `BASECOST="0"` and the rules price it per level.
 * `LEVELSTART` is where charging begins, so a three-level adder that starts at
 * one costs for two.
 *
 * Inferred from the reference character; worth revisiting when more characters
 * are available to check it against.
 */
export function adderCost(adder: Ability, powerRule: RuleNode | undefined): number {
  if (adder.baseCost !== 0) {
    return adder.levels > 0 ? adder.baseCost * adder.levels : adder.baseCost;
  }
  const rule = powerRule?.children?.find((child) => child.id === adder.xmlId);
  const perLevel = Number(rule?.attributes?.['LVLCOST'] ?? 0);
  if (perLevel === 0) {
    return 0;
  }
  const start = Number(rule?.attributes?.['LEVELSTART'] ?? 0);
  return Math.max(0, adder.levels - start) * perLevel;
}

/**
 * How far a power reaches, in inches.
 *
 * A power with its own area doubles it per level above the first, so a
 * three-level Change Environment covers 4". An Area Of Effect advantage instead
 * scales with the power it is bought on, one inch per ten base points.
 *
 * Both are inferred from the reference character.
 */
export function areaRadius(levels: number): number {
  return 2 ** Math.max(0, levels - 1);
}

export function advantageRadius(basePoints: number): number {
  return roundHalfUp(basePoints / 10);
}

function powerText(
  power: Ability,
  rule: RuleNode | undefined,
  basePoints: number,
  options: BuildPowerOptions,
): string {
  const parts: string[] = [baseText(power, rule, options)];

  const shown = power.adders.filter((adder) => adder.attributes['SHOWALIAS'] !== 'No').map(adderText);
  if (shown.length > 0 && !usesAddersInBaseText(power)) {
    parts.push(`, ${shown.join(', ')}`);
  }

  // An Area Of Effect names the area it covers, which depends on the power it
  // is bought on rather than on the advantage itself.
  const areaPrefix = `${formatInches(advantageRadius(basePoints))} `;
  const positive = advantages(power.modifiers).map(
    (modifier) => modifierText(modifier, modifier.xmlId === 'AOE' ? areaPrefix : '').text,
  );
  if (positive.length > 0) {
    parts.push(`, ${positive.join(', ')}`);
  }

  const negative = limitations(power.modifiers).map((modifier) => modifierText(modifier).text);

  if (power.modifiers.length > 0) {
    parts.push(` (${roundHalfUp(activeCost(basePoints, power.modifiers))} Active Points)`);
  }
  if (negative.length > 0) {
    parts.push(`; ${negative.join('; ')}`);
  }
  return parts.join('');
}

/**
 * The part of the description that names the power and how much of it there is.
 * What "how much" means differs by power: dice, inches, or points of defence.
 */
function baseText(power: Ability, rule: RuleNode | undefined, options: BuildPowerOptions): string {
  const alias = power.alias;
  const option = power.attributes['OPTION_ALIAS'];
  const prefix = option !== undefined && option.length > 0 ? `${option} ` : '';
  const input = power.attributes['INPUT'];

  if (FRAMEWORKS.has(power.element)) {
    return `${alias}, ${roundHalfUp(power.baseCost)}-point reserve`;
  }
  if (power.xmlId === 'DAMAGERESISTANCE') {
    const pd = Number(power.attributes['PDLEVELS'] ?? 0);
    const ed = Number(power.attributes['EDLEVELS'] ?? 0);
    return `${alias} (${pd} PD/${ed} ED)`;
  }
  if (POINT_DEFENCES.has(power.xmlId)) {
    return `${prefix}${alias} (${power.levels} points)`;
  }
  if (AREA_POWERS.has(power.xmlId)) {
    const effects = power.adders.map(adderText).join(', ');
    const detail = effects.length > 0 ? ` (${effects})` : '';
    return `${prefix}${alias} ${formatInches(areaRadius(power.levels))} radius${detail}`;
  }
  if (DISTANCE_POWERS.has(power.xmlId)) {
    return `${prefix}${alias} ${formatInches(power.levels)}`;
  }
  if (DICE_POWERS.has(power.xmlId)) {
    // Adjustment powers name what they act on — "Healing STUN 5d6". An attack
    // power's input is the defence it works against, which is not printed.
    const subject = ADJUSTMENT_POWERS.has(power.xmlId) && input !== undefined && input.length > 0
      ? `${input} `
      : '';
    return `${prefix}${alias} ${subject}${formatDice(power.levels * 5)}`;
  }

  if (options.strict !== false) {
    throw new HeroError(
      `This character has a power this renderer does not know how to describe yet: ` +
        `"${alias}" (${power.xmlId}). Render with strict mode turned off to print it plainly instead.`,
    );
  }
  return rule?.attributes?.['DISPLAY'] ?? alias;
}

/** Area powers fold their adders into the base text rather than listing them after. */
function usesAddersInBaseText(power: Ability): boolean {
  return AREA_POWERS.has(power.xmlId);
}

/**
 * A slot in a multipower costs a tenth of its real cost, rounded down, and is
 * written with a `u` for an ultra slot or `m` for a multi slot.
 */
function slotCost(power: Ability, real: number): string {
  if (power.parentId === undefined) {
    return String(roundHalfUp(real));
  }
  const suffix = power.attributes['ULTRA_SLOT'] === 'Yes' ? 'u' : 'm';
  return `${roundDown(real / 10)}${suffix}`;
}

/**
 * Endurance is a tenth of the active cost, and Reduced Endurance halves what is
 * left. Constant defences and framework reserves cost none.
 */
function enduranceOf(power: Ability, active: number, isFramework: boolean): string {
  if (isFramework) {
    return '';
  }
  if (POINT_DEFENCES.has(power.xmlId) || power.xmlId === 'DAMAGERESISTANCE') {
    return '0';
  }
  let end = roundDown(active / 10);
  const reduced = power.modifiers.find((modifier) => modifier.xmlId === 'REDUCEDEND');
  if (reduced !== undefined) {
    const option = reduced.attributes['OPTION_ALIAS'] ?? '';
    end = option.includes('0 END') ? 0 : roundDown(end / 2);
  }
  return String(end);
}

/**
 * A framework contributes its reserve and each slot the price printed against
 * it, so the column adds up to what the sheet shows.
 */
export function totalPowerCost(powers: readonly RenderedPower[]): number {
  return roundHalfUp(powers.reduce((sum, power) => sum + Number.parseFloat(power.cost), 0));
}
