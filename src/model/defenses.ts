import type { Ability } from '../hdc/types.ts';
import type { Bonus } from './characteristics.ts';

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
): Defences {
  const added: Contribution = {
    physical: 0,
    energy: 0,
    resistantPhysical: 0,
    resistantEnergy: 0,
    mental: 0,
    power: 0,
  };

  for (const source of sources) {
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
    mental: added.mental,
    power: added.power,
  };
}

/** Defence powers and talents that raise a characteristic's printed total. */
export function characteristicBonuses(sources: readonly Ability[]): Bonus[] {
  const bonuses: Bonus[] = [];
  for (const source of sources) {
    if (source.xmlId === 'COMBAT_LUCK') {
      const points = source.levels * COMBAT_LUCK_PER_LEVEL;
      bonuses.push({ id: 'PD', amount: points }, { id: 'ED', amount: points });
    }
    // Armor and Force Field are bought as points of defence and say so on the
    // characteristic line, where Damage Resistance only makes existing defence
    // resistant and adds nothing.
    if ((source.xmlId === 'ARMOR' || source.xmlId === 'FORCEFIELD') && source.attributes['AFFECTS_PRIMARY'] === 'Yes') {
      bonuses.push(
        { id: 'PD', amount: number(source.attributes['PDLEVELS']) },
        { id: 'ED', amount: number(source.attributes['EDLEVELS']) },
      );
    }
  }
  return bonuses;
}

function number(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
