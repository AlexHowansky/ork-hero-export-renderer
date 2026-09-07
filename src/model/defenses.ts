import type { Ability } from '../hdc/types.ts';
import type { Bonus } from './characteristics.ts';

/**
 * Movement powers that raise the characteristic they are named after. Leaping
 * is not among them: it is tracked as a forward and an upward distance, which
 * a power can raise one of without the other.
 */
const MOVEMENT_POWERS = new Set([
  'RUNNING', 'SWIMMING', 'FLIGHT', 'GLIDING', 'SWINGING', 'TELEPORTATION', 'TUNNELING',
]);

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
  primaryPd = characteristicPd,
  primaryEd = characteristicEd,
): Defences {
  return {
    ...totals(sources, characteristicPd, characteristicEd, (source) => affectsTotal(source)),
    ...primaryTotals(sources, primaryPd, primaryEd),
  };
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
): Pick<Defences, 'primaryPhysical' | 'primaryEnergy'> {
  const { physical, energy } = totals(sources, pd, ed, affectsPrimary);
  return { primaryPhysical: physical, primaryEnergy: energy };
}

function totals(
  sources: readonly Ability[],
  characteristicPd: number,
  characteristicEd: number,
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
      case 'POWERDEFENSE':
        added.power += source.levels;
        break;
      case 'MENTALDEFENSE':
        added.mental += source.levels;
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
  if (total.total === primary.total) {
    return { value: String(total.total), resistant: String(total.resistant) };
  }
  return {
    value: `${primary.total}/${total.total}`,
    resistant: `${primary.resistant}/${total.resistant}`,
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
    // Running bought as a power raises the Running characteristic, and with it
    // the distance and the endurance the sheet prints against it.
    if (MOVEMENT_POWERS.has(source.xmlId)) {
      bonuses.push({ id: source.xmlId, amount: source.levels, ...flags });
    }
  }
  return bonuses;
}

function number(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
