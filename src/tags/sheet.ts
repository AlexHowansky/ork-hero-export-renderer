import type { Ability, CharacterFile } from '../hdc/types.ts';
import { groupByFramework } from '../hdc/parse.ts';
import type { RuleSystem } from '../rules/types.ts';
import {
  buildDisadvantage,
  buildManeuver,
  buildSimple,
  buildSkill,
  ruleFor,
  skillRoll,
  totalCost,
  type RenderedAbility,
  type RenderedManeuver,
} from '../model/abilities.ts';
import { buildCharacteristics, characteristicNotes, type CharacteristicSet } from '../model/characteristics.ts';
import { characteristicBonuses, collectDefences, type Defences } from '../model/defenses.ts';
import { buildPower, totalPowerCost, type RenderedPower } from '../model/powers.ts';
import { summarisePoints, type PointsSummary } from '../model/points.ts';
import { formatInches, roundHalfUp } from '../model/numbers.ts';

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
  /** What Enhanced Perception adds to the PER roll, always on and in total. */
  readonly perception: { readonly primary: number; readonly total: number };
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
    character.powers,
  );

  const defences = collectDefences(
    contributors,
    characteristics.byId.get('PD')?.value ?? 0,
    characteristics.byId.get('ED')?.value ?? 0,
  );

  const allSkills = character.skills.map((skill) => buildSkill(skill, system, characteristics));
  // Combat levels are listed twice: once among the skills they were bought
  // with, and once in their own table.
  const skills = allSkills;
  const combatLevels = allSkills.filter((skill) => COMBAT_LEVEL_IDS.has(skill.source.xmlId));

  const perks = character.perks.map((perk) =>
    buildSimple(perk, system, ruleFor(system, 'PERKS', perk.xmlId)),
  );
  const talents = character.talents.map((talent) =>
    buildSimple(talent, system, ruleFor(system, 'TALENTS', talent.xmlId)),
  );
  const disadvantages = character.disadvantages.map((disadvantage) =>
    buildDisadvantage(disadvantage, system, ruleFor(system, 'DISADVANTAGES', disadvantage.xmlId)),
  );
  const { slotsByFrameworkId } = groupByFramework(character.powers);
  // Lists group entries the same way a framework groups its slots, and can head
  // any section, so every section is grouped for the list markup.
  const grouped = [
    slotsByFrameworkId,
    ...[character.equipment, character.disadvantages, character.skills, character.perks, character.talents]
      .map((section) => groupByFramework(section).slotsByFrameworkId),
  ];
  const frameworksById = new Map<string, Ability>();
  for (const framework of character.powers) {
    if (slotsByFrameworkId.has(framework.id)) {
      frameworksById.set(framework.id, framework);
    }
  }
  // A Linked modifier points at another power by id and prints what that power
  // is called, which is the player's own name for it when they gave it one.
  const linkTarget = (id: string): string | undefined => {
    const target = [...character.powers, ...character.equipment].find((power) => power.id === id);
    if (target === undefined) {
      return undefined;
    }
    return target.name.trim().length > 0 ? target.name : target.alias;
  };
  // Leaping prints its two distances; every other movement prints its total.
  const movementNote = (id: string): string | undefined => {
    const characteristic = characteristics.byId.get(id);
    if (characteristic === undefined) {
      return undefined;
    }
    return id === 'LEAPING'
      ? characteristicNotes(characteristic, characteristics, system)
      : `${formatInches(characteristic.total)} total`;
  };
  const strength = characteristics.byId.get('STR')?.total ?? 0;
  const build = (power: Ability) =>
    buildPower(power, system, {
      ...options,
      linkTarget,
      movementNote,
      strength,
      skillRoll: (skill) => skillRoll(skill, ruleFor(system, 'SKILLS', skill.xmlId), characteristics),
      ...(power.parentId !== undefined && frameworksById.has(power.parentId)
        ? { framework: frameworksById.get(power.parentId) as Ability }
        : {}),
    });
  const powers = character.powers.map(build);
  const equipment = character.equipment.map(build);
  const maneuvers = character.martialArts.map((maneuver) => buildManeuver(maneuver, strength));

  const frameworkIds = new Set(grouped.flatMap((section) => [...section.keys()]));
  const slotIds = new Set(
    grouped.flatMap((section) => [...section.values()].flat().map((slot: Ability) => slot.id)),
  );

  const perception = perceptionBonus(character.powers);

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
    perception,
    frameworkIds,
    slotIds,
  };
}

/**
 * What Enhanced Perception adds to the character's PER roll. A power worn in a
 * suit counts towards the total but not the always-on figure, and the sheet
 * then prints both.
 */
function perceptionBonus(powers: readonly Ability[]): { primary: number; total: number } {
  let primary = 0;
  let total = 0;
  for (const power of powers) {
    if (power.xmlId !== 'ENHANCEDPERCEPTION' || power.attributes['AFFECTS_TOTAL'] === 'No') {
      continue;
    }
    total += power.levels;
    if (power.attributes['AFFECTS_PRIMARY'] !== 'No') {
      primary += power.levels;
    }
  }
  return { primary, total };
}
