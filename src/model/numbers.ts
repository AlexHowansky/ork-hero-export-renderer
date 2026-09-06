/**
 * Arithmetic and number formatting that matches HERO Designer's.
 *
 * Two rules run through the whole rules engine and are worth stating once:
 *
 *   * Displayed values round, but totals do not add up rounded values. A
 *     character's characteristic costs show as 2, 2 and 16, yet contribute
 *     1.5, 1.5 and 16.4 to the total — which is why Redshift's sheet reads 168
 *     and not 169.
 *   * Fractions are written as `1/2` and `1/4` here, not `½` and `¼`. Templates
 *     convert them at the end with their own replacement rules, so producing
 *     the typographic forms early would stop those rules matching.
 */

/** Guards against 6.800000000000001 rounding as though it were above .5. */
const EPSILON_PLACES = 9;

function settle(value: number): number {
  return Number(value.toFixed(EPSILON_PLACES));
}

/**
 * HERO Designer rounds in two steps: it first throws away everything past the
 * first decimal place, then rounds that tenth to a whole number. So 8.57 is not
 * 9 but 8 — it becomes 8.5 first, and a half rounds down. Skipping the first
 * step gets an Elemental Control slot's cost wrong by a point.
 */
function toTenths(value: number, epsilon: number): number {
  const settled = settle(value + epsilon);
  return Math.trunc(settle(settled * 10)) / 10;
}

/** Rounds .5 away from zero, as HERO Designer's own rounder does. */
export function roundHalfUp(value: number): number {
  const tenths = toTenths(value, 0);
  const magnitude = Math.abs(tenths);
  const rounded = Math.floor(magnitude) + (settle(magnitude % 1) >= 0.5 ? 1 : 0);
  return tenths < 0 ? -rounded : rounded;
}

/** Rounds .5 towards zero. This is the rounder the cost arithmetic uses. */
export function roundHalfDown(value: number): number {
  const tenths = toTenths(value, 1e-11);
  const magnitude = Math.abs(tenths);
  const rounded = Math.floor(magnitude) + (settle(magnitude % 1) > 0.5 ? 1 : 0);
  return tenths < 0 ? -rounded : rounded;
}

export function roundDown(value: number): number {
  return Math.floor(settle(value));
}

export function roundUp(value: number): number {
  return Math.ceil(settle(value));
}

/**
 * Formats a number the way Java's `Double.toString` does, which is how some
 * values reach the page unrounded: an exported sheet really does contain
 * `8.666666666666666` for a DEX 26 character's OCV.
 *
 * JavaScript and Java both print the shortest form that round-trips, so they
 * agree except on whole numbers, where Java keeps a trailing `.0`.
 */
export function formatJavaDouble(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * Formats a number for display: whole numbers plain, fractions as `1/2` and
 * `1/4`, mixed numbers with a space, as in `3 1/2d6`.
 */
export function formatFraction(value: number): string {
  const settled = settle(value);
  const sign = settled < 0 ? '-' : '';
  const magnitude = Math.abs(settled);
  const whole = Math.floor(magnitude);
  const remainder = settle(magnitude - whole);

  const fraction = FRACTIONS.get(remainder);
  if (fraction === undefined) {
    return String(settled);
  }
  if (fraction === '') {
    return `${sign}${whole}`;
  }
  return whole === 0 ? `${sign}${fraction}` : `${sign}${whole} ${fraction}`;
}

const FRACTIONS = new Map<number, string>([
  [0, ''],
  [0.25, '1/4'],
  [0.5, '1/2'],
  [0.75, '3/4'],
]);

/** Formats a modifier's value with an explicit sign, as in `+1/4` or `-1/2`. */
export function formatSigned(value: number): string {
  return value < 0 ? formatFraction(value) : `+${formatFraction(value)}`;
}

/**
 * Dice for an amount of damage. HERO counts in 5-point dice, with a half die
 * at 3 points and a flat +1 at 2: 17 points is `3 1/2d6`.
 */
export function formatDice(points: number): string {
  const dice = Math.floor(settle(points) / 5);
  const remainder = settle(points - dice * 5);
  if (remainder >= 3) {
    return `${dice} 1/2d6`;
  }
  if (remainder >= 2) {
    return `${dice}d6+1`;
  }
  return `${dice}d6`;
}

/** A characteristic roll: 9 plus a fifth of the value, written `13-`. */
export function formatRoll(value: number): string {
  return `${9 + roundHalfUp(value / 5)}-`;
}

/** Distances are written in inches with a fraction, as in `3 1/2"`. */
export function formatInches(value: number): string {
  return `${formatFraction(value)}"`;
}
