import type { Ability, CharacterFile } from '../hdc/types.ts';
import { groupByFramework } from '../hdc/parse.ts';
import type { RuleSystem } from '../rules/types.ts';
import {
  buildDisadvantage,
  buildManeuver,
  buildSimple,
  buildSkill,
  ruleFor,
  totalCost,
  type RenderedAbility,
  type RenderedManeuver,
} from '../model/abilities.ts';
import { buildCharacteristics, type CharacteristicSet } from '../model/characteristics.ts';
import { characteristicBonuses, collectDefences, type Defences } from '../model/defenses.ts';
import { buildPower, totalPowerCost, type RenderedPower } from '../model/powers.ts';
import { summarisePoints, type PointsSummary } from '../model/points.ts';
import { roundHalfUp } from '../model/numbers.ts';

/**
 * Everything a template can ask about, worked out once before rendering starts.
 *
 * Assembling this up front rather than on demand keeps the tag resolvers
 * trivial, and means a character's defences and point totals are computed from
 * one consistent view rather than recalculated per tag.
 */
export interface Sheet {
  readonly character: CharacterFile;
  readonly system: RuleSystem;
  readonly characteristics: CharacteristicSet;
  readonly defences: Defences;
  readonly skills: readonly RenderedAbility[];
  readonly perks: readonly RenderedAbility[];
  readonly talents: readonly RenderedAbility[];
  readonly disadvantages: readonly RenderedAbility[];
  readonly powers: readonly RenderedPower[];
  readonly equipment: readonly RenderedPower[];
  readonly maneuvers: readonly RenderedManeuver[];
  /** Skill levels bought as combat levels, which print in their own table. */
  readonly combatLevels: readonly RenderedAbility[];
  readonly points: PointsSummary;
  /** Ids of powers that head a framework, and of those that are slots in one. */
  readonly frameworkIds: ReadonlySet<string>;
  readonly slotIds: ReadonlySet<string>;
}

export interface BuildSheetOptions {
  readonly strict?: boolean;
}

/** Skills that are really combat levels and are listed separately. */
const COMBAT_LEVEL_IDS = new Set(['COMBAT_LEVELS', 'MENTAL_COMBAT_LEVELS', 'SKILL_LEVELS']);

export function buildSheet(
  character: CharacterFile,
  system: RuleSystem,
  options: BuildSheetOptions = {},
): Sheet {
  // Talents and powers can raise a characteristic's total, so they are read
  // before the characteristics are built.
  const contributors = [...character.talents, ...character.powers];
  const characteristics = buildCharacteristics(
    character.characteristics,
    system,
    characteristicBonuses(contributors),
  );

  const defences = collectDefences(
    contributors,
    characteristics.byId.get('PD')?.value ?? 0,
    characteristics.byId.get('ED')?.value ?? 0,
  );

  const allSkills = character.skills.map((skill) => buildSkill(skill, system, characteristics));
  const skills = allSkills.filter((skill) => !COMBAT_LEVEL_IDS.has(skill.source.xmlId));
  const combatLevels = allSkills.filter((skill) => COMBAT_LEVEL_IDS.has(skill.source.xmlId));

  const perks = character.perks.map((perk) => buildSimple(perk, ruleFor(system, 'PERKS', perk.xmlId)));
  const talents = character.talents.map((talent) =>
    buildSimple(talent, ruleFor(system, 'TALENTS', talent.xmlId)),
  );
  const disadvantages = character.disadvantages.map((disadvantage) =>
    buildDisadvantage(disadvantage, ruleFor(system, 'DISADVANTAGES', disadvantage.xmlId)),
  );
  const powers = character.powers.map((power) => buildPower(power, system, options));
  const equipment = character.equipment.map((item) => buildPower(item, system, options));
  const strength = characteristics.byId.get('STR')?.total ?? 0;
  const maneuvers = character.martialArts.map((maneuver) => buildManeuver(maneuver, strength));

  const { slotsByFrameworkId } = groupByFramework(character.powers);
  const frameworkIds = new Set(slotsByFrameworkId.keys());
  const slotIds = new Set(
    [...slotsByFrameworkId.values()].flat().map((slot: Ability) => slot.id),
  );

  const points = summarisePoints({
    basePoints: character.configuration.basePoints,
    disadPointsAllowed: character.configuration.disadPoints,
    experienceEarned: character.configuration.experience,
    disadPointsUsed: totalCost(disadvantages),
    characteristics: characteristics.totalCost,
    skills: totalCost(allSkills),
    perks: totalCost(perks),
    talents: totalCost(talents),
    martialArts: roundHalfUp(maneuvers.reduce((sum, maneuver) => sum + maneuver.cost, 0)),
    powers: totalPowerCost(powers),
  });

  return {
    character,
    system,
    characteristics,
    defences,
    skills,
    perks,
    talents,
    disadvantages,
    powers,
    equipment,
    maneuvers,
    combatLevels,
    points,
    frameworkIds,
    slotIds,
  };
}
