import type { Ability } from '../hdc/types.ts';
import { formatSigned, roundHalfUp } from './numbers.ts';

/**
 * Advantages and limitations, and the arithmetic they drive.
 *
 * A power's *active cost* is its base cost multiplied by one plus the sum of
 * its advantages; its *real cost* is the active cost divided by one plus the
 * absolute total of its limitations. Adders are added to the base before either
 * multiplication.
 */

export interface ModifierText {
  readonly value: number;
  readonly text: string;
}

/**
 * `Reduced Endurance (1/2 END; +1/4)`, `Selective Target (+1/2)`,
 * `Affects Desolidified One Special Effect of Desolidification (only if ...; +1/4)`.
 *
 * The bracket holds whichever qualifier is the more specific. Normally that is
 * the chosen option, but when the player has written a comment of their own the
 * option moves out to sit beside the name and the comment takes the bracket.
 * An option that merely repeats the modifier's name is dropped.
 */
export function modifierText(modifier: Ability, optionPrefix = ''): ModifierText {
  const value = modifierValue(modifier);
  const signed = formatSigned(value);
  const rawOption = modifier.attributes['OPTION_ALIAS'] ?? '';
  const option = rawOption === modifier.alias ? '' : `${optionPrefix}${rawOption}`;
  const comments = modifier.attributes['COMMENTS'] ?? '';

  if (comments.length > 0) {
    const qualifier = option.length > 0 ? ` ${option}` : '';
    return { value, text: `${modifier.alias}${qualifier} (${comments}; ${signed})` };
  }
  const detail = option.length > 0 ? `${option}; ` : '';
  return { value, text: `${modifier.alias} (${detail}${signed})` };
}

export function modifierValue(modifier: Ability): number {
  const perLevel = modifier.levels > 0 ? modifier.baseCost * modifier.levels : modifier.baseCost;
  return modifier.adders.reduce((sum, adder) => sum + adder.baseCost, perLevel);
}

/**
 * Modifiers are listed smallest first, keeping the character file's order
 * within a tie — which is how `Reduced Endurance` comes before
 * `Affects Desolidified` even though both are +1/4.
 */
export function sortedModifiers(modifiers: readonly Ability[]): Ability[] {
  return modifiers
    .map((modifier, index) => ({ modifier, index, value: modifierValue(modifier) }))
    .sort((a, b) => a.value - b.value || a.index - b.index)
    .map((entry) => entry.modifier);
}

export function advantages(modifiers: readonly Ability[]): Ability[] {
  return sortedModifiers(modifiers).filter((modifier) => modifierValue(modifier) > 0);
}

export function limitations(modifiers: readonly Ability[]): Ability[] {
  return sortedModifiers(modifiers).filter((modifier) => modifierValue(modifier) < 0);
}

export function advantageTotal(modifiers: readonly Ability[]): number {
  return advantages(modifiers).reduce((sum, modifier) => sum + modifierValue(modifier), 0);
}

/** Limitations are quoted as negatives but divide as positives. */
export function limitationTotal(modifiers: readonly Ability[]): number {
  return Math.abs(limitations(modifiers).reduce((sum, modifier) => sum + modifierValue(modifier), 0));
}

export function activeCost(baseCost: number, modifiers: readonly Ability[]): number {
  return baseCost * (1 + advantageTotal(modifiers));
}

export function realCost(baseCost: number, modifiers: readonly Ability[]): number {
  return activeCost(baseCost, modifiers) / (1 + limitationTotal(modifiers));
}

/** `Common Motorized Ground Vehicles`, or `-3 DCV` for a valued adder. */
export function adderText(adder: Ability): string {
  const option = adder.attributes['OPTION_ALIAS'];
  if (option !== undefined && option.length > 0) {
    return `${adder.alias} ${option}`;
  }
  return adder.alias;
}

export function adderTotal(adders: readonly Ability[]): number {
  return adders.reduce(
    (sum, adder) => sum + (adder.levels > 0 ? adder.baseCost * adder.levels : adder.baseCost),
    0,
  );
}

/** `(75 Active Points)`, omitted when there is nothing to say. */
export function activePointsNote(active: number, hasModifiers: boolean): string {
  return hasModifiers ? ` (${roundHalfUp(active)} Active Points)` : '';
}
