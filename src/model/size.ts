import type { Ability } from '../hdc/types.ts';
import type { RuleNode } from '../rules/types.ts';
import { roundHalfUp } from './numbers.ts';

/**
 * Growth and Shrinking, the two powers that describe themselves in the
 * character's own measurements.
 *
 * Everything they print — how much STR the character gains, how heavy and how
 * tall they become — is worked out from the rules data (`STRINCREASE`,
 * `MASSMULTIPLIER` and the rest, each with the number of levels it applies per)
 * against the height and weight recorded in the character file. HERO Designer
 * keeps those as inches and pounds and prints metres and kilogrammes, using its
 * own rounded gramme-per-pound figure.
 */

/** Grammes in a pound, as HERO Designer rounds it. */
const GRAMMES_PER_POUND = 453.5924;
const CENTIMETRES_PER_INCH = 2.54;
/** A character is drawn half as wide as they are tall. */
const HEIGHT_TO_WIDTH = 2;

export interface CharacterSize {
  /** Height in inches and weight in pounds, as the character file records them. */
  readonly heightInches: number;
  readonly weightPounds: number;
}

/** Pounds as HERO Designer writes them in metric: kilogrammes. */
export function kilogrammes(pounds: number): number {
  return (pounds * GRAMMES_PER_POUND) / 1000;
}

export function characterSize(height: string, weight: string): CharacterSize {
  return { heightInches: number(height), weightPounds: number(weight) };
}

/**
 * `+30 STR, +6 BODY, +6 STUN, -6" KB, 2,496 kg, -4 DCV, +4 PER Rolls to
 * perceive character, 7 m tall, 3 m wide`.
 *
 * The measurements are rounded to whole metres and kilogrammes.
 */
export function growthDetail(power: Ability, rule: RuleNode | undefined, size: CharacterSize): string {
  const { levels } = power;
  const parts: string[] = [];
  const add = (key: string, suffix: string): void => {
    const amount = increase(rule, key, levels);
    if (amount !== 0) {
      parts.push(`${signed(amount)}${suffix}`);
    }
  };

  add('STR', ' STR');
  add('BODY', ' BODY');
  add('STUN', ' STUN');
  add('KB', '" KB');
  parts.push(`${thousands(roundHalfUp(mass(size, rule, levels)))} kg`);
  add('DCV', ' DCV');
  add('PER', ' PER Rolls to perceive character');
  parts.push(`${roundHalfUp(height(size, rule, levels))} m tall`);
  parts.push(`${roundHalfUp(height(size, rule, levels) / HEIGHT_TO_WIDTH)} m wide`);
  return parts.join(', ');
}

/**
 * `0.2037 m tall, 0.0762 kg mass, -6 PER Rolls to perceive character, +6 DCV`.
 *
 * A shrinking character is measured to four decimal places rather than rounded
 * to whole units, and — unlike Growth — the export leaves the knockback they
 * take unsaid.
 */
export function shrinkingDetail(power: Ability, rule: RuleNode | undefined, size: CharacterSize): string {
  const { levels } = power;
  const parts: string[] = [
    `${decimals(height(size, rule, levels))} m tall`,
    `${decimals(mass(size, rule, levels))} kg mass`,
  ];
  for (const [key, suffix] of [['PER', ' PER Rolls to perceive character'], ['DCV', ' DCV']] as const) {
    const amount = increase(rule, key, levels);
    if (amount !== 0) {
      parts.push(`${signed(amount)}${suffix}`);
    }
  }
  return parts.join(', ');
}

/**
 * What a size power adds to one characteristic: its per-level figure times the
 * number of whole blocks of levels bought. Growth gives +5 STR for every level
 * but only -2 DCV for every third.
 */
function increase(rule: RuleNode | undefined, key: string, levels: number): number {
  const attributes = rule?.attributes ?? {};
  return blocks(levels, attributes[`${key}INCREASELEVELS`]) * number(attributes[`${key}INCREASE`]);
}

function mass(size: CharacterSize, rule: RuleNode | undefined, levels: number): number {
  const attributes = rule?.attributes ?? {};
  const multiplier = number(attributes['MASSMULTIPLIER'], 1);
  return kilogrammes(size.weightPounds) * multiplier ** blocks(levels, attributes['MASSMULTIPLIERLEVELS']);
}

function height(size: CharacterSize, rule: RuleNode | undefined, levels: number): number {
  const attributes = rule?.attributes ?? {};
  const metres = (size.heightInches * CENTIMETRES_PER_INCH) / 100;
  const multiplier = number(attributes['HEIGHTINCREASE'], 1);
  return metres * multiplier ** blocks(levels, attributes['HEIGHTINCREASELEVELS']);
}

function blocks(levels: number, per: string | undefined): number {
  const size = number(per, 1) || 1;
  return Math.floor(levels / size);
}

/** Four decimal places, with any trailing zeroes dropped. */
function decimals(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, '');
}

function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ',');
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function number(value: string | undefined, fallback = 0): number {
  const parsed = Number(value);
  return value === undefined || !Number.isFinite(parsed) ? fallback : parsed;
}
