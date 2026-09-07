import { basename } from 'node:path';
import type { RenderContext } from '../template/renderer.ts';
import type { Ability } from '../hdc/types.ts';
import { HeroError } from '../util/errors.ts';
import { silentLogger, type Logger } from '../util/logger.ts';
import {
  characteristicBaseValue,
  characteristicDisplayValue,
  movementUnits,
  characteristicNotes,
  characteristicSecondaryValue,
  combatValue,
  hasRoll,
  hasSecondary,
  isCharacteristicName,
} from '../model/characteristics.ts';
import { defenceFigures } from '../model/defenses.ts';
import { equipmentFigures } from '../model/equipment.ts';
import { formatJavaDouble, formatRoll, roundHalfUp } from '../model/numbers.ts';
import type { RenderedAbility, RenderedManeuver } from '../model/abilities.ts';
import { totalPowerCost, type RenderedPower } from '../model/powers.ts';
import type { Sheet } from './sheet.ts';
import { evaluateMath } from './math.ts';

export interface ContextOptions {
  /** Unknown *values* fail loudly; unknown *tag names* always pass through. */
  readonly strict?: boolean;
  readonly logger?: Logger;
  /** Shown by `<!--CHARACTER_FILE-->`; defaults to the file's own name. */
  readonly characterFileName?: string;
  /** Shown by `<!--CHARACTER_SAVE_TIMESTAMP-->`. */
  readonly saveTimestamp?: Date;
  /** Shown by `<!--APP_VERSION-->`. */
  readonly appVersion?: string;
}

/** What a loop is currently iterating over. */
interface Scope {
  readonly ability?: Ability;
  readonly rendered?: RenderedAbility;
  readonly power?: RenderedPower;
  readonly maneuver?: RenderedManeuver;
  readonly characteristicId?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Suffixes that pair with a characteristic name, as in `<!--STR_ROLL-->`. */
const CHARACTERISTIC_SUFFIXES = [
  'PRIMARY', 'SECONDARY', 'BASE', 'COST', 'ROLL', 'NOTES', 'VAL', 'TOTAL',
  'RESISTANT_TOTAL', 'NONRESISTANT_TOTAL',
];

export function createContext(sheet: Sheet, options: ContextOptions = {}): RenderContext {
  const logger = options.logger ?? silentLogger;
  const scopes: Scope[] = [];
  const current = (): Scope => scopes[scopes.length - 1] ?? {};

  const missing = (name: string, detail: string): string => {
    if (options.strict !== false) {
      throw new HeroError(
        `The template asks for <!--${name}-->, but ${detail}. ` +
          'Render with strict mode turned off to leave it blank instead.',
      );
    }
    logger.warn(`<!--${name}-->: ${detail}; leaving it blank`);
    return '';
  };

  /** Repeats a container body once per item, with that item in scope. */
  const loop = <T>(items: readonly T[], toScope: (item: T) => Scope, render: () => string): string =>
    items
      .map((item) => {
        scopes.push(toScope(item));
        try {
          return render();
        } finally {
          scopes.pop();
        }
      })
      .join('');

  const resolveTag = (name: string): string | undefined => {
    const simple = simpleTag(sheet, name, options);
    if (simple !== undefined) {
      return simple;
    }
    const scoped = scopedTag(sheet, current(), name);
    if (scoped !== undefined) {
      return scoped;
    }
    const characteristic = characteristicTag(sheet, name);
    if (characteristic !== undefined) {
      return characteristic;
    }
    // Not a name this renderer knows. HERO Designer writes such directives out
    // unchanged, so we do too rather than guessing or failing.
    return undefined;
  };

  const resolveContainer = (name: string, render: () => string): string | undefined => {
    switch (name) {
      // Sections that repeat.
      case 'SKILLS':
        return loop(sheet.skills, (rendered) => ({ rendered, ability: rendered.source }), render);
      case 'PERKS':
        return loop(sheet.perks, (rendered) => ({ rendered, ability: rendered.source }), render);
      case 'TALENTS':
        return loop(sheet.talents, (rendered) => ({ rendered, ability: rendered.source }), render);
      case 'DISADS':
        return loop(sheet.disadvantages, (rendered) => ({ rendered, ability: rendered.source }), render);
      case 'COMBAT_LEVELS':
        return loop(sheet.combatLevels, (rendered) => ({ rendered, ability: rendered.source }), render);
      case 'POWERS':
        return loop(sheet.powers, (power) => ({ power, ability: power.source }), render);
      case 'EQUIPMENT':
        return loop(sheet.equipment, (power) => ({ power, ability: power.source }), render);
      case 'MANEUVERS':
        return loop(sheet.maneuvers, (maneuver) => ({ maneuver, ability: maneuver.source }), render);

      // Whether a section has anything in it.
      case 'IFSKILLS':
        return when(sheet.skills.length > 0, render);
      case 'IFPERKS':
        return when(sheet.perks.length > 0, render);
      case 'IFTALENTS':
        return when(sheet.talents.length > 0, render);
      case 'IFDISADS':
        return when(sheet.disadvantages.length > 0, render);
      case 'IFPOWERS':
        return when(sheet.powers.length > 0, render);
      case 'IFEQUIPMENT':
        return when(sheet.equipment.length > 0, render);
      case 'IFMANEUVERS':
        return when(sheet.maneuvers.length > 0, render);
      case 'IFCOMBAT_LEVELS':
        return when(sheet.combatLevels.length > 0, render);

      // Whether a piece of description was written.
      case 'IF_BACKGROUND':
        return when(sheet.character.info.background.length > 0, render);
      case 'IF_PERSONALITY':
        return when(sheet.character.info.personality.length > 0, render);
      case 'IF_QUOTE':
        return when(sheet.character.info.quote.length > 0, render);
      case 'IF_TACTICS':
        return when(sheet.character.info.tactics.length > 0, render);
      case 'IF_APPEARANCE':
        return when(sheet.character.info.appearance.length > 0, render);
      case 'IF_CAMPAIGN_USE':
        return when(sheet.character.info.campaignUse.length > 0, render);
      case 'IF_IMAGE':
        return when(sheet.character.image !== undefined, render);
      case 'IF_NO_IMAGE':
        return when(sheet.character.image === undefined, render);

      // The style block a player writes for their own sheet. Its line breaks
      // are dropped, which is how HERO Designer emits it.
      case 'CAMPAIGN_USE':
        return sheet.character.info.campaignUse.replaceAll('\n', '');

      // Questions about the item a loop is on.
      case 'IFNAME':
        return when((current().ability?.name ?? '').length > 0, render);
      case 'IFNOTES':
        return when(notesOf(current()).length > 0, render);
      case 'IF_SECONDARY':
        return when(secondaryOf(sheet, current()), render);
      case 'IS_LIST':
        return when(heads(sheet, current()), render);
      case 'IS_NOT_LIST':
        return when(!heads(sheet, current()), render);
      case 'IS_LIST_ITEM':
        return when(isSlot(sheet, current()), render);
      case 'IS_NOT_LIST_ITEM':
        return when(!isSlot(sheet, current()), render);
      case 'IS_ENHANCER':
        return when(isEnhancer(sheet, current()), render);

      case 'MATH':
        return evaluateMath(render(), { strict: options.strict !== false, logger });

      default:
        return characteristicContainer(sheet, name, scopes, render);
    }
  };

  return { resolveTag, resolveContainer };

  function characteristicContainer(
    built: Sheet,
    name: string,
    stack: Scope[],
    render: () => string,
  ): string | undefined {
    if (!isCharacteristicName(name)) {
      return undefined;
    }
    // A characteristic container is also a test: a fifth-edition character has
    // no OMCV, so <!--OMCV-->6<!--/OMCV--> renders as nothing at all.
    if (!built.characteristics.byId.has(name)) {
      return '';
    }
    stack.push({ characteristicId: name });
    try {
      return render();
    } finally {
      stack.pop();
    }
  }

  function characteristicTag(built: Sheet, name: string): string | undefined {
    for (const suffix of CHARACTERISTIC_SUFFIXES) {
      if (!name.endsWith(`_${suffix}`)) {
        continue;
      }
      const id = name.slice(0, -(suffix.length + 1));
      const characteristic = built.characteristics.byId.get(id);
      if (characteristic === undefined) {
        continue;
      }
      switch (suffix) {
        case 'PRIMARY':
        case 'VAL':
        case 'TOTAL':
          return characteristicDisplayValue(characteristic, movementUnits(built.system));
        case 'SECONDARY':
          return characteristicSecondaryValue(characteristic);
        case 'BASE':
          return characteristicBaseValue(characteristic);
        case 'COST':
          return String(characteristic.cost);
        case 'ROLL':
          if (!hasRoll(id, built.system)) {
            return '';
          }
          // A characteristic something raises without being always on rolls two
          // ways, and the sheet shows both: `11- / 12-`.
          return characteristic.primary === characteristic.total
            ? formatRoll(characteristic.total)
            : `${formatRoll(characteristic.primary)} / ${formatRoll(characteristic.total)}`;
        case 'NOTES':
          return characteristicNotes(characteristic, built.characteristics, built.system, {
            defences: defenceFor(built, id),
            perception: built.perception,
            movementEnd: movementEnd(built, id),
          });
        case 'RESISTANT_TOTAL':
          return defenceFor(built, id)?.resistant ?? '0';
        case 'NONRESISTANT_TOTAL':
          // Despite the name, HERO Designer prints the whole total here and
          // the resistant part separately: Redshift's sheet reads 12 and 12,
          // not 0 and 12.
          return defenceFor(built, id)?.value ?? '0';
        default:
          return undefined;
      }
    }
    return undefined;
  }

  function simpleTag(built: Sheet, name: string, opts: ContextOptions): string | undefined {
    const { info, configuration } = built.character;
    const points = built.points;
    switch (name) {
      case 'APP_VERSION':
        return opts.appVersion ?? '';
      case 'CHARACTER_FILE':
        return basename(opts.characterFileName ?? '');
      case 'CHARACTER_SAVE_TIMESTAMP':
        return opts.saveTimestamp === undefined ? '' : formatTimestamp(opts.saveTimestamp);
      case 'CHARACTER_NAME':
        return info.characterName;
      case 'ALTERNATE_IDS':
        return info.alternateIdentities;
      case 'PLAYER_NAME':
        return info.playerName;
      case 'CAMPAIGN_NAME':
        return info.campaignName;
      case 'GENRE':
        return info.genre;
      case 'GM':
        return info.gm;
      case 'HAIR_COLOR':
        return info.hairColor;
      case 'EYE_COLOR':
        return info.eyeColor;
      case 'HEIGHT':
        return info.height;
      case 'WEIGHT':
        return info.weight;
      case 'BACKGROUND':
        return info.background;
      case 'PERSONALITY':
        return info.personality;
      case 'QUOTE':
        return info.quote;
      case 'TACTICS':
        return info.tactics;
      case 'APPEARANCE':
        return info.appearance;

      case 'BASE_POINTS':
        return String(points.basePoints);
      case 'DISAD_POINTS':
        return String(points.disadPointsUsed);
      case 'DISAD_POINTS_ALLOWED':
        return String(points.disadPointsAllowed);
      case 'EARNED_EXP':
        return String(points.experienceEarned);
      case 'SPENT_EXP':
        return String(points.experienceSpent);
      case 'UNSPENT_EXP':
        return String(points.experienceUnspent);
      case 'TOTAL_POINTS':
        return String(points.totalPoints);
      case 'CHARACTERISTIC_POINTS':
        return String(built.characteristics.totalCost);
      case 'SKILL_POINTS':
        return String(sum(built.skills));
      case 'PERK_POINTS':
        return String(sum(built.perks));
      case 'TALENT_POINTS':
        return String(sum(built.talents));
      case 'POWER_POINTS':
        return String(totalPowerCost(built.powers));

      case 'OCV':
      case 'PRIMARY_OCV':
        return combat(built, 'OCV', name === 'OCV');
      case 'DCV':
      case 'PRIMARY_DCV':
        return combat(built, 'DCV', name === 'DCV');
      case 'ECV':
      case 'PRIMARY_ECV':
        return combat(built, 'ECV', name === 'ECV');
      // The mental combat values are characteristics of their own in sixth
      // edition and nothing at all in fifth, where the directive is left as it
      // stands rather than printed as a blank.
      case 'PRIMARY_OMCV':
        return built.characteristics.byId.get('OMCV')?.total.toString();
      case 'PRIMARY_DMCV':
        return built.characteristics.byId.get('DMCV')?.total.toString();

      case 'MENTAL_DEFENSE_TOTAL':
        return String(built.defences.mental);
      case 'POWER_DEFENSE_TOTAL':
        return String(built.defences.power);

      case 'IMAGE_HEX_DATA':
        return built.character.image === undefined
          ? ''
          : Buffer.from(built.character.image.base64, 'base64').toString('hex');
      case 'IMAGE_RELATIVE_URL':
        return built.character.image?.fileName ?? '';

      case 'RULES':
        return configuration.rules;
      default:
        return undefined;
    }
  }

  function combat(built: Sheet, which: 'OCV' | 'DCV' | 'ECV', rounded: boolean): string {
    // Sixth edition splits the mental combat value in two and prints the pair,
    // where fifth edition figures a single ECV from EGO.
    if (which === 'ECV') {
      const offensive = built.characteristics.byId.get('OMCV');
      const defensive = built.characteristics.byId.get('DMCV');
      if (offensive !== undefined && defensive !== undefined) {
        return `${offensive.total} - ${defensive.total}`;
      }
    }
    // A combat value bought as a characteristic is a whole number and prints
    // as one; a figured one keeps every place of the division that made it.
    const own = built.characteristics.byId.get(which);
    if (own !== undefined) {
      return String(own.total);
    }
    const value = combatValue(built.characteristics, built.system, which);
    if (value === undefined) {
      return missing(which, 'this character has no such combat value');
    }
    // The unrounded forms really do reach the page as Java doubles: an exported
    // sheet carries 8.666666666666666 for a DEX 26 character.
    return rounded ? String(roundHalfUp(value)) : formatJavaDouble(roundedPrimary(which, value));
  }
}

/**
 * HERO Designer prints the primary OCV unrounded but the primary DCV rounded —
 * an exported sheet shows 8.666666666666666 beside 9.0 for the same DEX.
 */
function roundedPrimary(which: 'OCV' | 'DCV' | 'ECV', value: number): number {
  return which === 'DCV' ? roundHalfUp(value) : value;
}

function scopedTag(sheet: Sheet, scope: Scope, name: string): string | undefined {
  const { rendered, power, maneuver, ability } = scope;
  switch (name) {
    case 'NAME':
      return ability?.name;
    case 'TEXT':
      return rendered?.text ?? power?.text;
    case 'NOTES':
      return notesOf(scope);

    case 'SKILL_TEXT':
    case 'PERK_TEXT':
    case 'TALENT_TEXT':
    case 'DISAD_TEXT':
    case 'COMBAT_LEVEL_TEXT':
      return rendered?.text;
    case 'SKILL_TEXT_NO_ROLL':
      return rendered?.text;
    case 'SKILL_ROLL':
    case 'PERK_ROLL':
    case 'TALENT_ROLL':
      // A skill enhancer does not roll at all — as opposed to rolling and
      // showing nothing, which is what a familiarity does — and HERO Designer
      // writes the directive itself out rather than an empty space.
      return rendered === undefined || isEnhancer(sheet, scope) ? undefined : rendered.roll;
    case 'SKILL_COST':
    case 'PERK_COST':
    case 'TALENT_COST':
    case 'DISAD_COST':
    case 'COMBAT_LEVEL_COST':
      if (rendered === undefined) {
        return undefined;
      }
      // A list heading is only a name; its cost column stays empty.
      return rendered.isList ? '' : String(rendered.cost);
    case 'SKILL_NOTES':
    case 'PERK_NOTES':
    case 'TALENT_NOTES':
    case 'DISAD_NOTES':
    case 'COMBAT_LEVEL_NOTES':
      return rendered?.notes;

    case 'POWER_TEXT':
    case 'EQUIPMENT_TEXT':
      return power?.text;
    case 'POWER_COST':
    case 'EQUIPMENT_COST':
      return power?.cost;
    case 'POWER_END':
    case 'EQUIPMENT_END':
      return power?.end;
    case 'POWER_NOTES':
    case 'EQUIPMENT_NOTES':
      return power?.notes;
    case 'EQUIPMENT_VALUE':
    case 'EQUIPMENT_TOTAL_VALUE':
    case 'EQUIPMENT_TOTAL_WEIGHT': {
      if (ability === undefined) {
        return undefined;
      }
      const figures = equipmentFigures(ability, sheet.character.houseRules);
      return name === 'EQUIPMENT_VALUE'
        ? figures.value
        : name === 'EQUIPMENT_TOTAL_VALUE' ? figures.totalValue : figures.totalWeight;
    }

    case 'MANEUVER_NAME':
      return maneuver?.name;
    case 'MANEUVER_PHASE':
      return maneuver?.phase;
    case 'MANEUVER_OCV':
      return maneuver?.ocv;
    case 'MANEUVER_DCV':
      return maneuver?.dcv;
    case 'MANEUVER_EFFECT':
      return maneuver?.effect;
    case 'MANEUVER_COST':
      return maneuver === undefined ? undefined : String(maneuver.cost);
    default:
      return undefined;
  }
}

function notesOf(scope: Scope): string {
  return scope.rendered?.notes ?? scope.power?.notes ?? scope.ability?.notes ?? '';
}

function isFramework(sheet: Sheet, scope: Scope): boolean {
  const id = scope.ability?.id;
  return id !== undefined && sheet.frameworkIds.has(id);
}

function isSlot(sheet: Sheet, scope: Scope): boolean {
  const id = scope.ability?.id;
  return id !== undefined && sheet.slotIds.has(id);
}

function defenceFor(sheet: Sheet, id: string): { value: string; resistant: string } | undefined {
  const { defences } = sheet;
  if (id === 'PD') {
    return defenceFigures(defences.physical, defences.primaryPhysical);
  }
  return id === 'ED' ? defenceFigures(defences.energy, defences.primaryEnergy) : undefined;
}

/**
 * The endurance the powers that raise a movement characteristic cost, which the
 * sheet adds to what the characteristic itself spends. A power the character
 * can be parted from counts towards the total but not the always-on figure, and
 * the endurance is then printed as a pair like everything else.
 */
function movementEnd(sheet: Sheet, id: string): { primary: number; total: number } {
  let primary = 0;
  let total = 0;
  for (const power of sheet.powers) {
    const { attributes, xmlId } = power.source;
    if (xmlId !== id || attributes['AFFECTS_TOTAL'] === 'No') {
      continue;
    }
    const end = Number.parseInt(power.end, 10) || 0;
    total += end;
    if (attributes['AFFECTS_PRIMARY'] !== 'No') {
      primary += end;
    }
  }
  return { primary, total };
}

/**
 * Whether the item a loop is on heads a group of others. A framework does, and
 * so does a skill enhancer, whether or not anything is grouped under it yet.
 */
function heads(sheet: Sheet, scope: Scope): boolean {
  return isFramework(sheet, scope) || isEnhancer(sheet, scope);
}

function isEnhancer(sheet: Sheet, scope: Scope): boolean {
  const id = scope.ability?.xmlId;
  return id !== undefined
    && sheet.system.sections.SKILL_ENHANCERS.entries.some((entry) => entry.id === id);
}

/** Whether the characteristic a container is on has a conditional half to show. */
function secondaryOf(sheet: Sheet, scope: Scope): boolean {
  const id = scope.characteristicId;
  const characteristic = id === undefined ? undefined : sheet.characteristics.byId.get(id);
  return characteristic !== undefined && hasSecondary(characteristic);
}

function when(condition: boolean, render: () => string): string {
  // A false condition collapses in place; the whitespace around it stays.
  return condition ? render() : '';
}

function sum(abilities: readonly RenderedAbility[]): number {
  return roundHalfUp(abilities.reduce((total, ability) => total + ability.rawCost, 0));
}

/** Java's `EEE, d MMM yyyy HH:mm:ss`, as HERO Designer stamps its exports. */
export function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${DAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
