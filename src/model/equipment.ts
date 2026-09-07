import type { Ability } from '../hdc/types.ts';
import { kilogrammes } from './size.ts';

/**
 * What a piece of equipment costs and weighs.
 *
 * Neither figure is a character point: equipment is bought with money, in
 * whatever currency the campaign uses, and carried at a weight the sheet prints
 * beside it. The campaign's `<RULES>` element says what that currency is called,
 * which side of the number its symbol goes, how many decimal places to write,
 * and what to multiply the stored price by to get there.
 */

export interface EquipmentFigures {
  /** What one of them costs. */
  readonly value: string;
  /** What all of them cost. */
  readonly totalValue: string;
  /** What all of them weigh. */
  readonly totalWeight: string;
}

/** Money is written to this many places when the campaign does not say. */
const DEFAULT_DECIMALS = 2;
/** Weight is always written to the gramme. */
const WEIGHT_DECIMALS = 2;
const WEIGHT_UNITS = 'kg';

export function equipmentFigures(
  item: Ability,
  houseRules: Readonly<Record<string, string>> = {},
): EquipmentFigures {
  const quantity = number(item.attributes['QUANTITY'], 1);
  const value = number(item.attributes['PRICE'], 0) * number(houseRules['EQUIPMENTCOSTCONVERSION'], 1);
  const weight = kilogrammes(number(item.attributes['WEIGHT'], 0));
  return {
    value: money(value, houseRules),
    totalValue: money(value * quantity, houseRules),
    totalWeight: `${(weight * quantity).toFixed(WEIGHT_DECIMALS)}${WEIGHT_UNITS}`,
  };
}

function money(amount: number, houseRules: Readonly<Record<string, string>>): string {
  const units = houseRules['EQUIPMENTCOSTUNITS'] ?? '';
  const written = amount.toFixed(number(houseRules['EQUIPMENTCOSTDECIMALPLACES'], DEFAULT_DECIMALS));
  return houseRules['EQUIPMENTUNITSPREFIX'] === 'No' ? `${written}${units}` : `${units}${written}`;
}

function number(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value === undefined || !Number.isFinite(parsed) ? fallback : parsed;
}
