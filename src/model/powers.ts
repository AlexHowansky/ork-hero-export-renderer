import type { Ability } from '../hdc/types.ts';
import type { RuleNode, RuleSystem, SectionName } from '../rules/types.ts';
import { isCharacteristicName } from './characteristics.ts';
import { skillCost, skillText } from './abilities.ts';
import { HeroError } from '../util/errors.ts';
import { formatDice, formatInches, roundDown, roundHalfDown, roundHalfUp, roundUp } from './numbers.ts';
import { growthDetail, shrinkingDetail, type CharacterSize } from './size.ts';
import { mentalDefenceFromEgo } from './defenses.ts';
import {
  CONTINUING_ADDER,
  activeCost,
  adderCost,
  adderRulesFrom,
  adderString,
  limitationTotal,
  modifierTail,
  realCost,
  type Costs,
  type ModifierEnv,
} from './modifiers.ts';

/**
 * Powers, and the text and prices that end up on the sheet.
 *
 * A power's description is assembled in a fixed order:
 *
 *   base text, adders, advantages (N Active Points); limitations
 *
 * with advantages before the active-point note and limitations after it, both
 * listed cheapest first, and the first limitation introduced by a semicolon
 * where the rest use commas.
 *
 * The prices come out of three numbers: the *total cost* (the power's own price
 * plus its adders), the *active cost* (total times one plus its advantages) and
 * the *real cost* (active divided by one plus its limitations). Each is rounded
 * as it is worked out rather than once at the end.
 */

export interface RenderedPower {
  readonly source: Ability;
  readonly text: string;
  readonly basePoints: number;
  readonly active: number;
  readonly real: number;
  /** `75`, or `7u` for a slot in a multipower. */
  readonly cost: string;
  readonly end: string;
  readonly notes: string;
  /** True for the framework itself rather than one of its slots. */
  readonly isFramework: boolean;
}

/** Powers whose levels are points of defence, printed as `(5 points)`. */
const POINT_DEFENCES = new Set(['POWERDEFENSE', 'FLASHDEFENSE', 'MENTALDEFENSE', 'LACKOFWEAKNESS']);
/** Powers measured in inches. */
const DISTANCE_POWERS = new Set([
  'STRETCHING', 'RUNNING', 'SWIMMING', 'LEAPING', 'FLIGHT', 'GLIDING', 'SWINGING', 'TELEPORTATION',
]);
/** Powers measured in dice of effect. */
const DICE_POWERS = new Set([
  'ENERGYBLAST', 'HEALING', 'DRAIN', 'AID', 'TRANSFER', 'EGOATTACK', 'RKA', 'HKA',
  'KILLINGATTACK', 'HANDTOHANDATTACK', 'ENTANGLE', 'FLASH', 'TELEPATHY', 'MINDCONTROL',
]);
/** Powers that cover an area and describe their effects inside it. */
const AREA_POWERS = new Set(['CHANGEENVIRONMENT']);
/** Powers that name the characteristic they act on in their description. */
const ADJUSTMENT_POWERS = new Set(['HEALING', 'DRAIN', 'AID', 'TRANSFER', 'SUCCOR', 'ABSORPTION']);
/** Elements that are frameworks rather than powers in their own right. */
const FRAMEWORKS = new Set(['MULTIPOWER', 'ELEMENTAL_CONTROL', 'VPP']);
/**
 * A list is a heading the player groups entries under. It is not a power: it
 * has no rules, no cost and no endurance, and prints as nothing but its name.
 */
const LIST_ELEMENT = 'LIST';
/** A skill can be bought as a power, and then prints its roll and pays for modifiers. */
const SKILL_ELEMENT = 'SKILL';
/** An Endurance Reserve is two powers in one: the store, and what refills it. */
const ENDURANCE_RESERVE = 'ENDURANCERESERVE';
const ENDURANCE_RESERVE_REC = 'ENDURANCERESERVEREC';
/**
 * Powers that name the senses they work on before anything else:
 * `Invisibility to Sight and Hearing Groups`, `Hearing Group Flash 3d6`.
 */
const SENSE_POWERS = new Set(['INVISIBILITY', 'DARKNESS', 'FLASH', 'IMAGES', 'CLAIRSENTIENCE']);
/** Attack powers that bracket their adders rather than listing them after a comma. */
const BRACKETS_ADDERS = new Set(['RKA', 'HKA', 'KILLINGATTACK', 'HANDTOHANDATTACK']);
/** Stands in for a character whose height and weight were never recorded. */
const NO_SIZE: CharacterSize = { heightInches: 0, weightPounds: 0 };
/** The sections a power's rules can live in, in the order they are searched. */
const RULE_SECTIONS: readonly SectionName[] = ['POWERS', 'CHARACTERISTICS', 'SKILLS', 'TALENTS'];

export interface BuildPowerOptions {
  /** When false, an unrecognised power is described generically instead of failing. */
  readonly strict?: boolean;
  /** The Multipower or Elemental Control this power is a slot in. */
  readonly framework?: Ability;
  /** What a Linked modifier's target is called on the sheet. */
  readonly linkTarget?: (id: string) => string | undefined;
  /**
   * What a movement power that raises the character's own total prints in
   * brackets — `12" total`, or for Leaping `1" forward, 10 1/2" upward` — which
   * only the characteristics know.
   */
  readonly movementNote?: (id: string) => string | undefined;
  /** The character's STR, which Clinging quotes as its own strength. */
  readonly strength?: number;
  /** The roll a skill bought as a power shows after its name. */
  readonly skillRoll?: (skill: Ability) => string;
  /** The character's EGO, which counts towards Mental Defense. */
  readonly ego?: number;
  /** The PER roll a sense such as Detect prints, given the levels bought. */
  readonly perceptionRoll?: (levels: number) => string;
  /** How tall and how heavy the character is, which the size powers quote. */
  readonly size?: CharacterSize;
}

export function buildPower(
  power: Ability,
  system: RuleSystem,
  options: BuildPowerOptions = {},
): RenderedPower {
  if (power.element === LIST_ELEMENT) {
    return {
      source: power,
      text: power.alias,
      basePoints: 0,
      active: 0,
      real: 0,
      cost: '',
      end: '',
      notes: power.notes,
      isFramework: false,
    };
  }

  const rule = ruleForPower(system, power);
  const isFramework = FRAMEWORKS.has(power.element);

  if (power.element === SKILL_ELEMENT) {
    return skillAsPower(power, rule, system, options);
  }
  if (power.xmlId === ENDURANCE_RESERVE) {
    return enduranceReserve(power, rule, system);
  }

  const total = powerTotalCost(power, rule, system);
  const active = activeCost(total, power.modifiers, system);
  const env: ModifierEnv = {
    system,
    activeCostExcluding: (xmlId) => activeCostExcluding(power, total, system, xmlId),
    linkTarget: options.linkTarget,
  };
  const real = powerRealCost(power, rule, active, system, options.framework);

  return {
    source: power,
    text: describe(power, rule, system, env, { total, active, real }, options),
    basePoints: total,
    active,
    real,
    cost: `${roundUp(real)}${slotSuffix(power, options.framework)}`,
    end: endColumn(power, rule, active, total, system),
    notes: power.notes,
    isFramework,
  };
}

/**
 * A skill listed among the powers — a voice modulator bought as Mimicry.
 *
 * It reads as a skill would, roll and all, but is priced as a power: its skill
 * cost is the active cost that its limitations then divide.
 */
function skillAsPower(
  skill: Ability,
  rule: RuleNode | undefined,
  system: RuleSystem,
  options: BuildPowerOptions,
): RenderedPower {
  const total = skillCost(skill, rule);
  const active = activeCost(total, skill.modifiers, system);
  // A skill in a framework is priced by the framework, exactly as a power is.
  const real = powerRealCost(skill, rule, active, system, options.framework);
  const roll = options.skillRoll?.(skill) ?? '';
  const text = `${skillText(skill, rule)}${roll.length > 0 ? ` ${roll}` : ''}`;
  return {
    source: skill,
    text: text + modifierTail(skill, { system }, { total, active, real }),
    basePoints: total,
    active,
    real,
    cost: `${roundUp(real)}${slotSuffix(skill, options.framework)}`,
    end: endColumn(skill, rule, active, total, system),
    notes: skill.notes,
    isFramework: false,
  };
}

/**
 * `Endurance Reserve  (100 END, 10 REC) Reserve:  (20 Active Points); IIF (…);
 * REC:  (10 Active Points); Limited Recovery (…)`.
 *
 * The store and its recovery are bought and limited separately — the suit's
 * battery is hard to get at, and only a wall socket refills it — so each half
 * prints its own modifiers and pays its own price, and the sheet charges for
 * both. The active points quoted against the reserve are the pair's together.
 */
function enduranceReserve(
  power: Ability,
  rule: RuleNode | undefined,
  system: RuleSystem,
): RenderedPower {
  const recovery = power.children.find((child) => child.xmlId === ENDURANCE_RESERVE_REC);
  const half = (part: Ability | undefined, partRule: RuleNode | undefined) => {
    if (part === undefined) {
      return { total: 0, active: 0, real: 0 };
    }
    const total = powerTotalCost(part, partRule, system);
    const active = activeCost(total, part.modifiers, system);
    return { total, active, real: realCost(active, part.modifiers, system) };
  };

  const store = half(power, rule);
  const refill = half(recovery, rule?.children?.find((child) => child.id === ENDURANCE_RESERVE_REC));
  const active = store.active + refill.active;
  const real = roundUp(store.real) + roundUp(refill.real);

  let text = `${power.alias}  (${power.levels} END, ${recovery?.levels ?? 0} REC)`;
  text += ` Reserve: ${modifierTail(power, { system }, { ...store, active })}`;
  if (recovery !== undefined) {
    text += `; REC: ${modifierTail(recovery, { system }, refill)}`;
  }

  return {
    source: power,
    text,
    basePoints: store.total + refill.total,
    active,
    real,
    cost: String(real),
    end: '0',
    notes: power.notes,
    isFramework: false,
  };
}

export function ruleForPower(system: RuleSystem, power: Ability): RuleNode | undefined {
  for (const section of RULE_SECTIONS) {
    const found = system.sections[section].entries.find((entry) => entry.id === power.xmlId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The rules node for the option a power has chosen, e.g. a Flash's sense group. */
function chosenOption(rule: RuleNode | undefined, power: Ability): RuleNode | undefined {
  const id = power.attributes['OPTIONID'];
  return id === undefined ? undefined : rule?.children?.find((child) => child.id === id);
}

/**
 * What a level of this power costs.
 *
 * Usually the rules say outright, but two kinds of power price their levels by
 * what the player picked: a sense-affecting power charges more for a targeting
 * sense than for any other, and a skill level charges by how widely it applies.
 */
function levelPrice(
  power: Ability,
  rule: RuleNode | undefined,
  system: RuleSystem,
): { value: number; cost: number } {
  const option = chosenOption(rule, power);
  const attributes = rule?.attributes ?? {};

  if (attributes['SENSECOST'] !== undefined) {
    // A sense modifier is priced by how much it covers: one sense, a whole
    // sense group, or every sense the character has.
    const chosen = power.attributes['OPTIONID'] ?? '';
    const key = chosen === 'ALL' ? 'ALLCOST' : chosen.endsWith('GROUP') ? 'GROUPCOST' : 'SENSECOST';
    return {
      value: num(attributes['LVLVAL'], 1),
      cost: num(attributes[key], 0),
    };
  }
  if (attributes['TARGETINGCOST'] !== undefined) {
    const targeting = isTargetingGroup(system, power.attributes['OPTIONID']);
    return {
      value: num(power.attributes['LVLVAL'] ?? attributes['LVLVAL'], 1),
      cost: num(attributes[targeting ? 'TARGETINGCOST' : 'NONTARGETINGCOST'], 0),
    };
  }
  return {
    value: num(power.attributes['LVLVAL'] ?? option?.attributes?.['LVLVAL'] ?? attributes['LVLVAL'], 0),
    cost: num(power.attributes['LVLCOST'] ?? option?.attributes?.['LVLCOST'] ?? attributes['LVLCOST'], 0),
  };
}

/** Sight is a targeting sense; hearing, radio and the rest are not. */
function isTargetingGroup(system: RuleSystem, groupId: string | undefined): boolean {
  if (groupId === undefined) {
    return false;
  }
  const group = system.sections.POWERS.entries.find((entry) => entry.id === groupId);
  return (group?.children ?? []).some(
    (child) => child.element === 'PROVIDES' && child.text === 'TARGETINGSENSE',
  );
}

/**
 * The power's own price plus its adders, before any modifier touches it.
 *
 * Levels are bought in blocks: Armor is 3 points for every 2 points of defence,
 * so 38 levels cost 57 rather than 114.
 */
export function powerTotalCost(power: Ability, rule: RuleNode | undefined, system: RuleSystem): number {
  let total = power.baseCost;
  const { value, cost } = levelPrice(power, rule, system);
  if (value !== 0) {
    let blocks = Math.floor(power.levels / value);
    if (power.levels % value !== 0 && value > 1) {
      blocks += 1;
    }
    total += blocks * cost;
    if (cost < value) {
      total = total > 0 && total < 1 ? 1 : roundHalfDown(total);
    }
  }

  const rules = adderRulesFrom(rule);
  const adderCosts = power.adders.map((adder) => adderCost(adder, rules(adder)));
  total += adderCosts.reduce((sum, entry) => sum + entry, 0);

  // Change Environment's first level of its cheapest effect comes with the
  // power, so one level's worth of that adder is knocked off again.
  if (AREA_POWERS.has(power.xmlId)) {
    let cheapest: number | undefined;
    power.adders.forEach((adder, index) => {
      const price = adderRate(adder, rules(adder));
      if ((adderCosts[index] ?? 0) > 0 && price !== undefined && (cheapest === undefined || price < cheapest)) {
        cheapest = price;
      }
    });
    total -= cheapest ?? 0;
  }
  return total;
}

/** What one level of an adder costs, when it is priced by the level at all. */
function adderRate(adder: Ability, rule: RuleNode | undefined): number | undefined {
  const value = num(adder.attributes['LVLVAL'] ?? rule?.attributes?.['LVLVAL'], 0);
  const cost = num(adder.attributes['LVLCOST'] ?? rule?.attributes?.['LVLCOST'], 0);
  return value > 0 && cost > 0 ? cost / value : undefined;
}

/** The active cost the power would have without one of its advantages. */
function activeCostExcluding(
  power: Ability,
  total: number,
  system: RuleSystem,
  xmlId: string,
): number {
  const kept = power.modifiers.filter((modifier) => modifier.xmlId !== xmlId);
  return activeCost(total, kept, system);
}

/**
 * The real cost, which is where a power framework changes the arithmetic.
 *
 * A Multipower slot pays a tenth (an ultra slot) or a fifth (a multi slot) of
 * what it would cost alone. An Elemental Control slot instead has the control's
 * own cost taken off its active cost before its limitations divide it, and
 * never costs less than the control does.
 */
function powerRealCost(
  power: Ability,
  rule: RuleNode | undefined,
  active: number,
  system: RuleSystem,
  framework: Ability | undefined,
): number {
  if (framework?.element === 'ELEMENTAL_CONTROL') {
    const reserve = framework.baseCost;
    const above = Math.max(reserve, active - reserve);
    if (above === 0) {
      return 0;
    }
    const total = limitationTotal(power.modifiers, system);
    const cost = total > 0 ? roundHalfDown(above / (1 + total)) : above / (1 + total);
    return Math.max(1, cost);
  }

  const alone = standaloneRealCost(power, rule, active, system);
  if (framework?.element === 'MULTIPOWER') {
    const share = roundHalfDown(alone / (power.attributes['ULTRA_SLOT'] === 'Yes' ? 10 : 5));
    return alone > 0 && share < 1 ? 1 : share;
  }
  return alone;
}

/**
 * What the power costs on its own.
 *
 * A power normally cannot cost nothing — anything that works out below a point
 * is charged one — but a power whose price has been written down by an adder of
 * the player's own is left where it lands, which is how a character can carry a
 * power that costs zero.
 */
function standaloneRealCost(
  power: Ability,
  rule: RuleNode | undefined,
  active: number,
  system: RuleSystem,
): number {
  const cost = realCost(active, power.modifiers, system);
  const rules = adderRulesFrom(rule);
  const written = power.adders.some((adder) => {
    const known = (rule?.children ?? []).some((child) => child.id === adder.xmlId);
    return (!known || adder.xmlId === 'GENERIC_OBJECT') && adderCost(adder, rules(adder)) <= 0;
  });
  return cost < 1 && !written ? 1 : cost;
}

function slotSuffix(power: Ability, framework: Ability | undefined): string {
  if (framework?.element !== 'MULTIPOWER') {
    return '';
  }
  return power.attributes['ULTRA_SLOT'] === 'Yes' ? 'u' : 'm';
}

// ------------------------------------------------------------- endurance

/**
 * The endurance column.
 *
 * A power that costs no END prints a bare `0`, unless it runs on charges, which
 * it prints instead as `[6]`. Frameworks, skills, talents and characteristics
 * leave the column empty rather than printing a zero.
 */
function endColumn(
  power: Ability,
  rule: RuleNode | undefined,
  active: number,
  total: number,
  system: RuleSystem,
): string {
  if (FRAMEWORKS.has(power.element)) {
    return '';
  }
  const end = endUsage(power, rule, active, total, system);
  if (end > 0) {
    return String(end);
  }
  if (power.element !== 'POWER') {
    return '';
  }
  const charges = power.modifiers.find((modifier) => modifier.xmlId === 'CHARGES');
  if (charges === undefined) {
    return '0';
  }
  // Charges that keep working once spent are marked as such: `[4 cc]`.
  const continuing = charges.adders.some((adder) => adder.xmlId === CONTINUING_ADDER);
  return `[${charges.attributes['OPTION_ALIAS'] ?? ''}${continuing ? ' cc' : ''}]`;
}

/** One point of END for every ten active points, before the modifiers that change that. */
export function endUsage(
  power: Ability,
  rule: RuleNode | undefined,
  active: number,
  total: number,
  system: RuleSystem,
): number {
  const find = (xmlId: string) => power.modifiers.find((modifier) => modifier.xmlId === xmlId);
  // Only what the rules say uses endurance does; a talent says nothing and so
  // leaves the column empty.
  let perEnd = rule?.attributes?.['USESEND'] === 'Yes' ? 10 : 0;
  let points = active;
  let share = 1;

  if (find('CHARGES') !== undefined) {
    perEnd = 0;
  }
  const costsEnd = find('COSTSEND');
  if (costsEnd !== undefined) {
    perEnd = 10;
    if (costsEnd.attributes['OPTIONID'] === 'HALFEND') {
      share = 0.5;
    }
  }
  const reduced = find('REDUCEDEND');
  if (reduced !== undefined) {
    if (reduced.attributes['OPTIONID'] === 'HALFEND') {
      share = 0.5;
    } else {
      perEnd = 0;
    }
    points = activeCostExcluding(power, total, system, 'REDUCEDEND');
  }
  if (find('COSTSENDONLYTOACTIVATE') !== undefined) {
    points = activeCostExcluding(power, total, system, 'COSTSENDONLYTOACTIVATE');
  }

  if (perEnd === 0) {
    return 0;
  }
  let end = roundHalfDown(points / perEnd);
  if (end === 0 && points > 0) {
    end = 1;
  }
  end = roundHalfDown(end * share);
  if (end === 0 && points > 0) {
    end = 1;
  }
  return Math.max(0, end);
}

// ----------------------------------------------------------- description

function describe(
  power: Ability,
  rule: RuleNode | undefined,
  system: RuleSystem,
  env: ModifierEnv,
  costs: Costs,
  options: BuildPowerOptions,
): string {
  return baseText(power, rule, system, costs, options) + modifierTail(power, env, costs);
}

/**
 * Everything before the modifiers: what the power is, how much of it there is,
 * and whatever the player added to it.
 */
function baseText(
  power: Ability,
  rule: RuleNode | undefined,
  system: RuleSystem,
  costs: Costs,
  options: BuildPowerOptions,
): string {
  const rules = adderRulesFrom(rule);
  const option = powerOption(power, system);

  if (FRAMEWORKS.has(power.element)) {
    // A Multipower is quoted by its reserve; an Elemental Control by the size
    // of the powers it will hold, which is twice what the control itself costs.
    return power.element === 'ELEMENTAL_CONTROL'
      ? `${power.alias}, ${roundDown(costs.active) * 2}-point powers`
      : `${power.alias}, ${roundHalfUp(power.baseCost)}-point reserve`;
  }

  if (SENSE_POWERS.has(power.xmlId)) {
    return senseText(power, rule);
  }

  const adders = adderString(power.adders, rules, hiddenAdders(power), separatorFor(power));
  const head = damageText(power, rule, options);

  // A killing or hand-to-hand attack brackets its adders; every other power
  // lists them after a comma.
  if (BRACKETS_ADDERS.has(power.xmlId)) {
    return adders.length > 0 ? `${head} (${adders})` : head;
  }
  // Life Support lists what it protects against in a bracket of its own, and
  // keeps the space where its (empty) amount would have gone.
  if (power.xmlId === 'LIFESUPPORT') {
    return adders.length > 0 ? `${head}  (${adders})` : head;
  }
  // An area power brackets its effects: `Change Environment 4" radius (-3 DCV)`.
  if (AREA_POWERS.has(power.xmlId)) {
    return adders.length > 0 ? `${head} (${adders})` : head;
  }
  // Detect names what it senses, how well the character rolls to notice it,
  // and only then the sense group it belongs to.
  if (power.xmlId === 'DETECT') {
    const roll = options.perceptionRoll?.(power.levels) ?? '';
    const group = senseGroup(power, system);
    const detected = [head, option, roll].filter((part) => part.length > 0).join(' ');
    const detail = group.length > 0 ? `${detected} (${group})` : detected;
    return adders.length > 0 ? `${detail}, ${adders}` : detail;
  }
  // Shape Shift brackets its sense group together with the shapes it can take,
  // and keeps the space where its (empty) amount would have gone.
  if (power.xmlId === 'SHAPESHIFT') {
    // The shapes on offer are chosen as an option of an adder that asks not to
    // be listed as one, so the power quotes the option itself.
    const shapes = power.adders
      .filter((adder) => adder.attributes['DISPLAYINSTRING'] === 'No')
      .map((adder) => adder.attributes['OPTION_ALIAS'] ?? '');
    const inside = [option, ...shapes, adders].filter((part) => part.length > 0).join(', ');
    return inside.length > 0 ? `${head}  (${inside})` : head;
  }
  const namesOwnOption = POINT_DEFENCES.has(power.xmlId)
    || rule?.attributes?.['SENSECOST'] !== undefined;
  const withOption = option.length > 0 && !namesOwnOption ? `${head} (${option})` : head;
  return adders.length > 0 ? `${withOption}, ${adders}` : withOption;
}

/**
 * What the power says in brackets after its name. Usually the option the player
 * chose; a sense such as Radar instead names the group it perceives with.
 */
function powerOption(power: Ability, system: RuleSystem): string {
  const option = power.attributes['OPTION_ALIAS'];
  if (option !== undefined && option.length > 0) {
    return option;
  }
  const group = power.attributes['GROUP'];
  if (group === undefined) {
    return '';
  }
  return system.sections.POWERS.entries.find((entry) => entry.id === group)?.attributes?.['DISPLAY'] ?? '';
}

/** What the rules call the sense group a power perceives with. */
function senseGroup(power: Ability, system: RuleSystem): string {
  const group = power.attributes['GROUP'];
  if (group === undefined) {
    return '';
  }
  return system.sections.POWERS.entries.find((entry) => entry.id === group)?.attributes?.['DISPLAY'] ?? '';
}

/** Life Support separates the environments it protects against with semicolons. */
function separatorFor(power: Ability): string {
  return power.xmlId === 'LIFESUPPORT' ? '; ' : ', ';
}

/**
 * Adders a power folds into its own text rather than listing separately:
 * Tunneling's `+7 DEF` is already in `through 8 DEF material`.
 */
function hiddenAdders(power: Ability): ReadonlySet<string> {
  return power.xmlId === 'TUNNELING' ? new Set(['DEFBONUS']) : new Set();
}

/**
 * The part of the description that names the power and how much of it there is.
 * What "how much" means differs by power: dice, inches, or points of defence.
 */
function damageText(
  power: Ability,
  rule: RuleNode | undefined,
  options: BuildPowerOptions,
): string {
  const alias = power.alias;
  const input = power.attributes['INPUT'];

  // A sense modifier names the sense it sharpens: `Discriminatory with Normal
  // Smell`, and for Enhanced Perception the levels it buys as well.
  if (rule?.attributes?.['SENSECOST'] !== undefined) {
    const head = power.xmlId === 'ENHANCEDPERCEPTION' ? `${signed(power.levels)} PER` : alias;
    const sense = power.attributes['OPTION_ALIAS'] ?? '';
    return sense.length > 0 ? `${head} with ${sense}` : head;
  }
  if (power.xmlId === 'CLINGING') {
    // Clinging holds on with the character's own STR plus what was bought, and
    // says so as "normal STR" when nothing was bought.
    return power.levels === 0
      ? `${alias} (normal STR)`
      : `${alias} (${(options.strength ?? 0) + power.levels} STR)`;
  }
  if (power.xmlId === 'TELEKINESIS') {
    // Telekinesis lifts as if it had a strength of its own.
    return `${alias} (${power.levels} STR)`;
  }
  if (power.xmlId === 'EXTRALIMBS') {
    return `${alias}  (${power.levels})`;
  }
  if (power.xmlId === 'GROWTH') {
    return `${alias} (${growthDetail(power, rule, options.size ?? NO_SIZE)})`;
  }
  if (power.xmlId === 'SHRINKING') {
    return `${alias} (${shrinkingDetail(power, rule, options.size ?? NO_SIZE)})`;
  }
  if (power.xmlId === 'DESOLIDIFICATION') {
    // Desolidification names what it can be affected by, and keeps the space
    // before it even when the player named nothing.
    return `${alias} ${input ?? ''}`;
  }

  if (power.xmlId === 'ARMOR' || power.xmlId === 'FORCEFIELD') {
    return `${alias} (${defenceLevels(power)})`;
  }
  if (power.xmlId === 'DAMAGERESISTANCE') {
    return `${alias} (${defenceLevels(power)})`;
  }
  if (POINT_DEFENCES.has(power.xmlId)) {
    const option = power.attributes['OPTION_ALIAS'] ?? '';
    const prefix = option.length > 0 ? `${option} ` : '';
    // Mental Defense counts the character's own EGO towards its points, and
    // writes the figure as a total to say so.
    if (power.xmlId === 'MENTALDEFENSE') {
      const points = power.levels + mentalDefenceFromEgo(options.ego ?? 0);
      return `${prefix}${alias} (${points} points total)`;
    }
    return `${prefix}${alias} (${power.levels} points)`;
  }
  if (power.xmlId === 'KBRESISTANCE') {
    return `${alias} -${power.levels}"`;
  }
  if (power.xmlId === 'TUNNELING') {
    const bonus = power.adders.find((adder) => adder.xmlId === 'DEFBONUS')?.levels ?? 0;
    return `${alias} ${power.levels}" through ${power.levels + bonus} DEF material`;
  }
  if (AREA_POWERS.has(power.xmlId)) {
    return `${alias} ${formatInches(areaRadius(power.levels))} radius`;
  }
  const raises = power.attributes['AFFECTS_TOTAL'] === 'Yes'
    ? options.movementNote?.(power.xmlId)
    : undefined;
  if (DISTANCE_POWERS.has(power.xmlId) && raises !== undefined) {
    // A movement power that raises a movement characteristic prints what that
    // becomes — `12" total`, or for Leaping a forward and an upward distance —
    // and its own levels as the amount it adds. Stretching raises nothing, so
    // it just says how far it reaches.
    return `${alias} ${signed(power.levels)}"${raises.length > 0 ? ` (${raises})` : ''}`;
  }
  if (DISTANCE_POWERS.has(power.xmlId)) {
    return `${alias} ${formatInches(power.levels)}`;
  }
  if (power.xmlId === 'ENTANGLE') {
    // An Entangle is as hard to break out of as it is strong.
    return `${alias} ${formatDice(power.levels * 5)}, ${power.levels} DEF`;
  }
  if (DICE_POWERS.has(power.xmlId)) {
    // Adjustment powers name what they act on — "Healing STUN 5d6". An attack
    // power's input is the defence it works against, which is not printed.
    const subject = ADJUSTMENT_POWERS.has(power.xmlId) && input !== undefined && input.length > 0
      ? `${input} `
      : '';
    const plus = power.xmlId === 'HANDTOHANDATTACK' ? '+' : '';
    return `${alias} ${subject}${plus}${formatDice(power.levels * 5)}`;
  }
  if (isCharacteristicName(power.xmlId)) {
    // A characteristic bought as a power says how much it adds: `+23 STR`.
    return `${signed(power.levels)} ${alias}`;
  }
  if (rule !== undefined) {
    // Everything else is named and left at that: Radar, Missile Deflection,
    // Life Support and the rest carry their detail in options and adders.
    return alias;
  }

  if (options.strict !== false) {
    throw new HeroError(
      `This character has a power this renderer does not know how to describe yet: ` +
        `"${alias}" (${power.xmlId}). Render with strict mode turned off to print it plainly instead.`,
    );
  }
  return alias;
}

function defenceLevels(power: Ability): string {
  const parts: string[] = [];
  const add = (key: string, label: string, always = false) => {
    const levels = num(power.attributes[key], 0);
    if (levels > 0 || always) {
      parts.push(`${levels} ${label}`);
    }
  };
  // Armor bought against one kind of damage still says how much it stops of
  // the other: "Armor (6 PD/0 ED)".
  add('PDLEVELS', 'PD', true);
  add('EDLEVELS', 'ED', true);
  add('MDLEVELS', 'Mental Def.');
  add('FDLEVELS', 'Flash Def.');
  add('POWDLEVELS', 'Power Def.');
  return parts.join('/');
}

/**
 * A power that works on the senses names them first.
 *
 * Invisibility and Darkness read "to Sight and Hearing Groups"; Flash and
 * Images put the groups in front of their own name. Either way the groups are
 * the power's chosen one plus every group bought as an adder, and those adders
 * are then not listed again.
 */
function senseText(power: Ability, rule: RuleNode | undefined): string {
  const rules = adderRulesFrom(rule);
  const groups = [trimGroup(power.attributes['OPTION_ALIAS'] ?? '[Unknown]')];
  const hidden = new Set<string>();
  for (const adder of power.adders) {
    if (adder.xmlId.endsWith('GROUP')) {
      hidden.add(adder.xmlId);
      groups.push(trimGroup(adder.alias));
    }
  }
  const list = joinWithAnd(groups) + (groups.length > 1 ? ' Groups' : ' Group');
  const adders = adderString(power.adders, rules, hidden);

  switch (power.xmlId) {
    case 'INVISIBILITY':
      // The amount is empty, but the space before it is not dropped.
      return `${power.alias} to ${list} ${adders.length > 0 ? `, ${adders}` : ''}`.replace(/ $/, ' ');
    case 'DARKNESS': {
      const head = `${power.alias} to ${list} ${power.levels}" radius`;
      return adders.length > 0 ? `${head}, ${adders}` : head;
    }
    case 'FLASH': {
      const head = `${list} ${power.alias} ${formatDice(power.levels * 5)}`;
      return adders.length > 0 ? `${head}, ${adders}` : head;
    }
    case 'IMAGES': {
      const head = `${list} ${power.alias} 1" radius`;
      return adders.length > 0 ? `${head}, ${adders}` : head;
    }
    default: {
      // Clairsentience brackets its group and puts its range adder first.
      const range = power.adders.find((adder) => adder.xmlId === 'INCREASEDRANGE');
      const parts: string[] = [];
      if (range !== undefined) {
        hidden.add(range.xmlId);
        parts.push(`${range.alias} (${clairsentienceRange(power, range)}")`);
      }
      const rest = adderString(power.adders, rules, hidden);
      if (rest.length > 0) {
        parts.push(rest);
      }
      const head = `${power.alias} (${list})`;
      return parts.length > 0 ? `${head}, ${parts.join(', ')}` : head;
    }
  }
}

/**
 * How far Clairsentience sees: five inches per point the power costs before any
 * adder, doubled once for each `x2 Range` level.
 */
function clairsentienceRange(power: Ability, range: Ability): number {
  return roundHalfUp(roundHalfUp(power.baseCost * 5) * 2 ** range.levels);
}

function trimGroup(alias: string): string {
  const index = alias.toUpperCase().indexOf('GROUP');
  return index > 0 ? alias.slice(0, index).trim() : alias;
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts.join('');
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * A power with its own area doubles it per level above the first, so a
 * three-level Change Environment covers 4".
 */
export function areaRadius(levels: number): number {
  return 2 ** Math.max(0, levels - 1);
}

/**
 * A framework contributes its reserve and each slot the price printed against
 * it, so the column adds up to what the sheet shows.
 */
export function totalPowerCost(powers: readonly RenderedPower[]): number {
  // A list heading prints no cost at all, so it contributes nothing.
  return roundHalfUp(
    powers.reduce((sum, power) => sum + (Number.parseFloat(power.cost) || 0), 0),
  );
}
