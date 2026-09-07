import type { Ability } from '../hdc/types.ts';
import { isCharacteristicName, type Bonus } from './characteristics.ts';
import { roundHalfUp } from './numbers.ts';

/**
 * Leaping is the one characteristic a power named after it does not simply add
 * to: it is tracked as a forward and an upward distance, which a power can
 * raise one of without the other.
 */
const NOT_A_BONUS = new Set(['LEAPING']);

/**
 * Defences, gathered from everything that grants them.
 *
 * Powers and talents contribute in two different ways. Some add points of
 * defence outright — Combat Luck gives 3 resistant PD and ED per level. Damage
 * Resistance adds nothing, but makes defence a character already has resistant,
 * which is why Redshift shows 12 PD of which all 12 are resistant.
 */

export interface Defences {
  readonly physical: DefenceTotals;
  readonly energy: DefenceTotals;
  /**
   * The same two figures counting only what is always on. Armor worn in a suit
   * raises the total but not this, and the sheet then prints the pair — `6/16
   * PD (0/10 rPD)` — rather than one number.
   */
  readonly primaryPhysical: DefenceTotals;
  readonly primaryEnergy: DefenceTotals;
  readonly mental: number;
  readonly power: number;
}

export interface DefenceTotals {
  readonly total: number;
  readonly resistant: number;
}

/** Resistant defence granted per level, for talents that work that way. */
const COMBAT_LUCK_PER_LEVEL = 3;

interface Contribution {
  physical: number;
  energy: number;
  resistantPhysical: number;
  resistantEnergy: number;
  mental: number;
  power: number;
}

export function collectDefences(
  sources: readonly Ability[],
  characteristicPd: number,
  characteristicEd: number,
  ego = 0,
  primaryPd = characteristicPd,
  primaryEd = characteristicEd,
): Defences {
  return {
    ...totals(sources, characteristicPd, characteristicEd, ego, (source) => affectsTotal(source)),
    ...primaryTotals(sources, primaryPd, primaryEd, ego),
  };
}

/**
 * What a character's own EGO is worth as Mental Defense.
 *
 * It counts only for a character who has bought the power at all — which is why
 * the sheet writes that total as "13 points total" rather than "10 points" —
 * and a character with no Mental Defense shows none however high their EGO.
 */
export function mentalDefenceFromEgo(ego: number): number {
  return roundHalfUp(ego / 5);
}

/** A source marked off on both counts nowhere; one marked off on the primary counts only in the total. */
function affectsTotal(source: Ability): boolean {
  return source.attributes['AFFECTS_TOTAL'] !== 'No';
}

function affectsPrimary(source: Ability): boolean {
  return affectsTotal(source) && source.attributes['AFFECTS_PRIMARY'] !== 'No';
}

function primaryTotals(
  sources: readonly Ability[],
  pd: number,
  ed: number,
  ego: number,
): Pick<Defences, 'primaryPhysical' | 'primaryEnergy'> {
  const { physical, energy } = totals(sources, pd, ed, ego, affectsPrimary);
  return { primaryPhysical: physical, primaryEnergy: energy };
}

function totals(
  sources: readonly Ability[],
  characteristicPd: number,
  characteristicEd: number,
  ego: number,
  keep: (source: Ability) => boolean,
): Defences {
  const added: Contribution = {
    physical: 0,
    energy: 0,
    resistantPhysical: 0,
    resistantEnergy: 0,
    mental: 0,
    power: 0,
  };

  for (const source of sources.filter(keep)) {
    switch (source.xmlId) {
      case 'COMBAT_LUCK': {
        const points = source.levels * COMBAT_LUCK_PER_LEVEL;
        added.physical += points;
        added.energy += points;
        added.resistantPhysical += points;
        added.resistantEnergy += points;
        break;
      }
      case 'DAMAGERESISTANCE':
        // Converts existing defence rather than adding any.
        added.resistantPhysical += number(source.attributes['PDLEVELS']);
        added.resistantEnergy += number(source.attributes['EDLEVELS']);
        break;
      case 'ARMOR':
      case 'FORCEFIELD':
        added.physical += number(source.attributes['PDLEVELS']);
        added.energy += number(source.attributes['EDLEVELS']);
        added.resistantPhysical += number(source.attributes['PDLEVELS']);
        added.resistantEnergy += number(source.attributes['EDLEVELS']);
        break;
      case 'PD':
        added.physical += source.levels;
        break;
      case 'ED':
        added.energy += source.levels;
        break;
      case 'POWERDEFENSE':
        added.power += source.levels;
        break;
      case 'MENTALDEFENSE':
        added.mental += source.levels + mentalDefenceFromEgo(ego);
        break;
      default:
        break;
    }
  }

  const physical = characteristicPd + added.physical;
  const energy = characteristicEd + added.energy;
  return {
    physical: { total: physical, resistant: Math.min(physical, added.resistantPhysical) },
    energy: { total: energy, resistant: Math.min(energy, added.resistantEnergy) },
    primaryPhysical: { total: 0, resistant: 0 },
    primaryEnergy: { total: 0, resistant: 0 },
    mental: added.mental,
    power: added.power,
  };
}

/**
 * A defence figure as the sheet writes it: one number when everything counting
 * towards it is always on, and `primary/total` when something is not.
 */
export function defenceFigures(
  total: DefenceTotals,
  primary: DefenceTotals,
): { readonly value: string; readonly resistant: string } {
  // The defence itself decides whether the pair is shown at all: a character
  // whose PD does not change with the suit reads `12 PD (12 rPD)` however much
  // of it the suit makes resistant. Once it is shown, the resistant half is
  // still written as one figure when it is the same either way — a suit that
  // adds 5 PD and no resistance reads `3/8 PD (0 rPD)`.
  if (primary.total === total.total) {
    return { value: String(total.total), resistant: String(total.resistant) };
  }
  return {
    value: `${primary.total}/${total.total}`,
    resistant: primary.resistant === total.resistant
      ? String(total.resistant)
      : `${primary.resistant}/${total.resistant}`,
  };
}

/** Defence powers and talents that raise a characteristic's printed total. */
export function characteristicBonuses(sources: readonly Ability[]): Bonus[] {
  const bonuses: Bonus[] = [];
  for (const source of sources) {
    const flags = {
      affectsPrimary: affectsPrimary(source),
      affectsTotal: affectsTotal(source),
    };
    if (source.xmlId === 'COMBAT_LUCK') {
      const points = source.levels * COMBAT_LUCK_PER_LEVEL;
      bonuses.push({ id: 'PD', amount: points, ...flags }, { id: 'ED', amount: points, ...flags });
    }
    // Armor and Force Field are bought as points of defence and say so on the
    // characteristic line, where Damage Resistance only makes existing defence
    // resistant and adds nothing.
    if (source.xmlId === 'ARMOR' || source.xmlId === 'FORCEFIELD') {
      bonuses.push(
        { id: 'PD', amount: number(source.attributes['PDLEVELS']), ...flags },
        { id: 'ED', amount: number(source.attributes['EDLEVELS']), ...flags },
      );
    }
    // A characteristic bought as a power raises that characteristic: Running
    // bought as a power lengthens the stride and the endurance printed against
    // it, and +5 STR bought in a suit is 5 more STR while the suit is on.
    if (isCharacteristicName(source.xmlId) && !NOT_A_BONUS.has(source.xmlId)) {
      bonuses.push({ id: source.xmlId, amount: source.levels, ...flags });
    }
  }
  return bonuses;
}

function number(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
