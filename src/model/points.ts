import { roundHalfUp } from './numbers.ts';

/**
 * The points summary.
 *
 * A character's total is what they have spent, and experience spent is whatever
 * that total exceeds the campaign's starting allowance by. Every component is
 * summed from exact costs, so a fraction here and there does not drift.
 */
export interface PointsSummary {
  readonly basePoints: number;
  readonly disadPointsAllowed: number;
  readonly disadPointsUsed: number;
  readonly experienceEarned: number;
  readonly experienceSpent: number;
  readonly experienceUnspent: number;
  /** Everything spent, across every section. */
  readonly totalPoints: number;
}

export interface PointsInput {
  readonly basePoints: number;
  readonly disadPointsAllowed: number;
  readonly experienceEarned: number;
  readonly disadPointsUsed: number;
  readonly characteristics: number;
  readonly skills: number;
  readonly perks: number;
  readonly talents: number;
  readonly martialArts: number;
  readonly powers: number;
}

export function summarisePoints(input: PointsInput): PointsSummary {
  const totalPoints = roundHalfUp(
    input.characteristics + input.skills + input.perks + input.talents + input.martialArts + input.powers,
  );
  // Anything spent beyond the starting allowance came out of experience.
  const experienceSpent = Math.max(0, totalPoints - input.basePoints - input.disadPointsUsed);
  return {
    basePoints: input.basePoints,
    disadPointsAllowed: input.disadPointsAllowed,
    disadPointsUsed: input.disadPointsUsed,
    experienceEarned: input.experienceEarned,
    experienceSpent,
    experienceUnspent: input.experienceEarned - experienceSpent,
    totalPoints,
  };
}
