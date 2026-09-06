import type { Ability } from '../hdc/types.ts';
import type { RuleNode, RuleSystem } from '../rules/types.ts';
import { formatDice, formatFraction, formatInches, formatRoll, roundDown, roundHalfDown, roundHalfUp } from './numbers.ts';

/**
 * A characteristic as it appears on the sheet.
 *
 * Bases are where the game's arithmetic lives. Some characteristics are
 * *figured*: their base is derived from others, and the derivation is data, not
 * code — `Main.hdt` says STR carries `PDINCREASE="1" PDINCREASELEVELS="5"`,
 * meaning every 5 points of STR adds 1 to PD's base. Reading those attributes
 * rather than hard-coding the fifth-edition table means the sixth-edition rules
 * fall out of the same logic.
 */
export interface Characteristic {
  readonly id: string;
  /** `STR`, `Running` — the label the sheet shows. */
  readonly alias: string;
  /** Unrounded base, including any figured contributions. */
  readonly rawBase: number;
  /** The base as displayed. */
  readonly base: number;
  /** The characteristic's own value, before powers and talents add to it. */
  readonly value: number;
  /** Value including everything that adds to this characteristic. */
  readonly total: number;
  /** Exact cost, which is what totals are summed from. */
  readonly rawCost: number;
  /** Cost as displayed. */
  readonly cost: number;
  readonly levels: number;
  readonly notes: string;
  /**
   * How far the character moves, for the movement characteristics. Leaping
   * tracks two figures because a power can raise one without the other.
   */
  readonly movement?: { readonly forward: number; readonly upward: number };
}

/**
 * SPD is the one characteristic whose base is genuinely fractional in play — a
 * DEX 26 character has a 3.6 base — and HERO Designer shows it that way rather
 * than rounding. Its value is then counted up from the whole part.
 */
const FRACTIONAL_BASE = new Set(['SPD']);

/** Characteristics that show a roll on the sheet. */
const HAS_ROLL = new Set(['STR', 'DEX', 'CON', 'BODY', 'INT', 'EGO', 'PRE', 'COM']);

/**
 * Every characteristic name either edition uses, in resolution order — a
 * figured characteristic needs its sources computed first.
 *
 * The list also answers "is this a characteristic?" for names the current
 * game system does not have. A fifth-edition character has no OMCV, and the
 * template's `<!--OMCV-->6<!--/OMCV-->` must then render as nothing rather
 * than being passed through as an unknown directive.
 */
export const CHARACTERISTIC_IDS = [
  'STR', 'DEX', 'CON', 'BODY', 'INT', 'EGO', 'PRE', 'COM',
  'OCV', 'DCV', 'OMCV', 'DMCV', 'SPD', 'PD', 'ED', 'REC', 'END', 'STUN',
  'RUNNING', 'SWIMMING', 'LEAPING', 'FLIGHT', 'GLIDING', 'SWINGING',
  'TELEPORTATION', 'TUNNELING',
] as const;

export function isCharacteristicName(name: string): boolean {
  return (CHARACTERISTIC_IDS as readonly string[]).includes(name);
}

export interface CharacteristicSet {
  readonly byId: ReadonlyMap<string, Characteristic>;
  /** In the order the character file lists them. */
  readonly all: readonly Characteristic[];
  /** Exact sum of every characteristic's cost, rounded once at the end. */
  readonly totalCost: number;
}

export interface Bonus {
  /** Characteristic id the bonus applies to. */
  readonly id: string;
  readonly amount: number;
}

export function buildCharacteristics(
  character: readonly Ability[],
  system: RuleSystem,
  bonuses: readonly Bonus[] = [],
  movementPowers: readonly Ability[] = [],
): CharacteristicSet {
  const rules = new Map(system.sections.CHARACTERISTICS.entries.map((entry) => [entry.id, entry]));
  const owned = new Map(character.map((ability) => [ability.xmlId, ability]));

  const values = new Map<string, number>();
  const built = new Map<string, Characteristic>();

  for (const id of orderedIds(rules)) {
    const rule = rules.get(id);
    if (rule === undefined) {
      continue;
    }
    const ability = owned.get(id);
    const levels = ability?.levels ?? 0;

    const rawBase = figuredBase(id, rule, rules, values);
    const fractional = FRACTIONAL_BASE.has(id);
    const base = fractional ? rawBase : roundHalfUp(rawBase);
    const value = (fractional ? roundDown(rawBase) : base) + levels;
    values.set(id, value);

    if (ability === undefined) {
      continue;
    }

    // Cost is measured from the base as displayed, not from the raw figure.
    // PD's base of 3.6 shows as 4, and its cost is counted from 4 — using 3.6
    // here inflates the sheet's characteristic total from 168 to 169.
    const attributes = rule.attributes ?? {};
    const rawCost = ((value - base) * number(attributes['LVLCOST'], 0)) / number(attributes['LVLVAL'], 1);
    const bonus = bonuses
      .filter((entry) => entry.id === id)
      .reduce((sum, entry) => sum + entry.amount, 0);

    built.set(id, {
      id,
      ...(id === 'LEAPING' ? { movement: leapingDistances(rawBase + levels, movementPowers) } : {}),
      alias: ability.alias.length > 0 ? ability.alias : id,
      rawBase,
      base,
      value,
      total: value + bonus,
      rawCost,
      cost: roundHalfUp(rawCost),
      levels,
      notes: '',
    });
  }

  const all = character
    .map((ability) => built.get(ability.xmlId))
    .filter((entry): entry is Characteristic => entry !== undefined);

  return {
    byId: built,
    all,
    // Rounded once over exact costs, never by adding up rounded ones.
    totalCost: roundHalfUp(all.reduce((sum, entry) => sum + entry.rawCost, 0)),
  };
}

/**
 * How far the character leaps.
 *
 * Leaping is bought forward, and the character gets half as much upward for
 * free. A Leaping power says which half it buys: one marked "Upward Movement
 * Only" adds its whole value to the upward figure and nothing to the forward
 * one.
 */
function leapingDistances(
  value: number,
  powers: readonly Ability[],
): { forward: number; upward: number } {
  let forward = value;
  let upward = value / 2;
  for (const power of powers) {
    if (power.xmlId !== 'LEAPING' || power.attributes['AFFECTS_TOTAL'] === 'No') {
      continue;
    }
    const has = (id: string) => power.modifiers.some((modifier) => modifier.xmlId === id);
    if (!has('UPWARDMOVEMENTONLY')) {
      forward += power.levels;
    }
    if (!has('FORWARDMOVEMENTONLY')) {
      upward += power.levels / 2;
    }
  }
  return { forward, upward };
}

/** Characteristics the rules define, in dependency order. */
function orderedIds(rules: ReadonlyMap<string, RuleNode>): string[] {
  const known = [...rules.keys()];
  const ordered: string[] = CHARACTERISTIC_IDS.filter((id) => rules.has(id));
  return [...ordered, ...known.filter((id) => !ordered.includes(id))];
}

/**
 * A characteristic's base: its own `BASE`, plus a contribution from every
 * characteristic that declares an increase for it.
 */
function figuredBase(
  id: string,
  rule: RuleNode,
  rules: ReadonlyMap<string, RuleNode>,
  values: ReadonlyMap<string, number>,
): number {
  let base = number(rule.attributes?.['BASE'], 0);
  for (const [sourceId, source] of rules) {
    const increase = source.attributes?.[`${id}INCREASE`];
    const per = source.attributes?.[`${id}INCREASELEVELS`];
    const sourceValue = values.get(sourceId);
    if (increase === undefined || per === undefined || sourceValue === undefined) {
      continue;
    }
    base += (sourceValue * Number(increase)) / Number(per);
  }
  return base;
}

/** Offensive and defensive combat values, derived from DEX or from their own characteristic. */
export function combatValue(
  set: CharacteristicSet,
  system: RuleSystem,
  which: 'OCV' | 'DCV' | 'OMCV' | 'DMCV' | 'ECV',
): number | undefined {
  const own = set.byId.get(which === 'ECV' ? 'ECV' : which);
  if (own !== undefined) {
    return own.total;
  }
  // Fifth edition has no combat-value characteristics: they are figured from
  // DEX, or from EGO for the mental ones.
  const source = which === 'ECV' || which === 'OMCV' || which === 'DMCV' ? 'EGO' : 'DEX';
  const from = set.byId.get(source);
  if (from === undefined) {
    return undefined;
  }
  const rule = system.sections.CHARACTERISTICS.entries.find((entry) => entry.id === source);
  const key = which === 'OMCV' || which === 'DMCV' ? 'ECV' : which;
  const increase = rule?.attributes?.[`${key}INCREASE`];
  const per = rule?.attributes?.[`${key}INCREASELEVELS`];
  if (increase === undefined || per === undefined) {
    return undefined;
  }
  return (from.total * Number(increase)) / Number(per);
}

/**
 * The Notes column. These are computed strings, not anything stored in the
 * character file.
 */
export function characteristicNotes(
  characteristic: Characteristic,
  set: CharacteristicSet,
  system: RuleSystem,
  defenses: { readonly resistant: number; readonly total: number } | undefined,
): string {
  const { id, total } = characteristic;
  switch (id) {
    case 'STR':
      return `HTH Damage ${formatDice(total)}  END [${Math.max(1, roundHalfUp(total / 10))}]`;
    case 'DEX': {
      const ocv = combatValue(set, system, 'OCV');
      const dcv = combatValue(set, system, 'DCV');
      return ocv === undefined || dcv === undefined
        ? ''
        : `OCV ${roundHalfUp(ocv)} DCV ${roundHalfUp(dcv)}`;
    }
    case 'INT':
      return `PER Roll ${formatRoll(total)}`;
    case 'EGO': {
      const ecv = combatValue(set, system, 'ECV');
      return ecv === undefined ? '' : `ECV: ${roundHalfUp(ecv)}`;
    }
    case 'PRE':
      return `PRE Attack: ${formatDice(total)}`;
    case 'PD':
    case 'ED':
      return defenses === undefined
        ? ''
        : `${defenses.total} ${id} (${defenses.resistant} r${id})`;
    case 'SPD':
      // Two spaces after the colon, as everywhere else on the sheet.
      return `Phases:  ${phases(total).join(', ')}`;
    case 'LEAPING': {
      const { forward, upward } = characteristic.movement ?? { forward: 0, upward: 0 };
      return `${formatInches(floorToHalf(forward))} forward, ${formatInches(floorToHalf(upward))} upward`;
    }
    case 'RUNNING':
    case 'SWIMMING':
      // One point of END buys five inches of movement, so a character who has
      // bought none of either spends none.
      return `END [${total > 0 ? Math.max(1, roundHalfDown(total / 5)) : 0}]`;
    default:
      return '';
  }
}

/** Which of the twelve segments a character acts in, at a given SPD. */
export function phases(speed: number): number[] {
  const count = Math.max(0, Math.min(12, roundDown(speed)));
  const result: number[] = [];
  for (let segment = 1; segment <= 12; segment++) {
    if (Math.floor((segment * count) / 12) > Math.floor(((segment - 1) * count) / 12)) {
      result.push(segment);
    }
  }
  return result;
}

/**
 * Distances come out in half inches, rounded down: a STR 18 character leaps
 * 3.6 inches by the arithmetic and 3 1/2" on the sheet. Leaping also shows its
 * upward distance, half the forward one and rounded the same way.
 */
export function movementDistance(characteristic: Characteristic): number {
  return floorToHalf(characteristic.rawBase + characteristic.levels);
}

export function characteristicDisplayValue(characteristic: Characteristic): string {
  if (characteristic.id === 'LEAPING') {
    const { forward, upward } = characteristic.movement ?? { forward: 0, upward: 0 };
    return `${formatInches(floorToHalf(forward))}/${formatInches(floorToHalf(upward))}`;
  }
  return formatFraction(characteristic.total);
}

function floorToHalf(value: number): number {
  return Math.floor(Number(value.toFixed(9)) * 2) / 2;
}

export function hasRoll(id: string): boolean {
  return HAS_ROLL.has(id);
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
