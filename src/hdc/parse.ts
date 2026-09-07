import { childNamed, parseXml, type XmlElement } from '../xml/parse.ts';
import { InvalidFileError } from '../util/errors.ts';
import { templateIdFromReference } from '../rules/hdt.ts';
import { decodeCharacterFile } from './decode.ts';
import type {
  Ability,
  BasicConfiguration,
  CharacterFile,
  CharacterImage,
  CharacterInfo,
} from './types.ts';

/** Section element name -> the field it populates. */
const SECTIONS = {
  CHARACTERISTICS: 'characteristics',
  SKILLS: 'skills',
  PERKS: 'perks',
  TALENTS: 'talents',
  MARTIALARTS: 'martialArts',
  POWERS: 'powers',
  DISADVANTAGES: 'disadvantages',
  EQUIPMENT: 'equipment',
} as const satisfies Record<string, keyof CharacterFile>;

/** Nested elements that are folded into named fields rather than `children`. */
const NOTES_ELEMENT = 'NOTES';
const ADDER_ELEMENT = 'ADDER';
const MODIFIER_ELEMENT = 'MODIFIER';

export function parseCharacterFile(input: Uint8Array | string, source?: string): CharacterFile {
  const text = typeof input === 'string' ? input : decodeCharacterFile(input, source).text;
  const options = source === undefined ? {} : { source };
  const root = parseXml(text, options);

  if (root.name !== 'CHARACTER') {
    throw new InvalidFileError(
      `Expected this file to start with a <CHARACTER> element, but found <${root.name}>. ` +
        'It does not look like a HERO Designer character file.',
      { ...options, line: root.line },
    );
  }

  const templateReference = root.attributes['TEMPLATE'];
  if (templateReference === undefined || templateReference.trim().length === 0) {
    throw new InvalidFileError(
      'This character file does not say which game system it uses, so its rules cannot be looked up.',
      { ...options, line: root.line },
    );
  }

  const sections = {
    characteristics: [] as Ability[],
    skills: [] as Ability[],
    perks: [] as Ability[],
    talents: [] as Ability[],
    martialArts: [] as Ability[],
    powers: [] as Ability[],
    disadvantages: [] as Ability[],
    equipment: [] as Ability[],
  };
  for (const [element, field] of Object.entries(SECTIONS)) {
    const section = childNamed(root, element);
    if (section !== undefined) {
      sections[field as keyof typeof sections] = section.children.map(toAbility);
    }
  }

  const image = childNamed(root, 'IMAGE');

  return {
    version: root.attributes['version'] ?? '',
    templateId: templateIdFromReference(templateReference, source),
    configuration: readConfiguration(childNamed(root, 'BASIC_CONFIGURATION')),
    info: readInfo(childNamed(root, 'CHARACTER_INFO')),
    houseRules: childNamed(root, 'RULES')?.attributes ?? {},
    ...sections,
    ...(image === undefined ? {} : { image: readImage(image) }),
  };
}

function readConfiguration(element: XmlElement | undefined): BasicConfiguration {
  const attributes = element?.attributes ?? {};
  return {
    basePoints: numberOr(attributes['BASE_POINTS'], 0),
    disadPoints: numberOr(attributes['DISAD_POINTS'], 0),
    experience: numberOr(attributes['EXPERIENCE'], 0),
    exportTemplate: attributes['EXPORT_TEMPLATE'] ?? '',
    rules: attributes['RULES'] ?? '',
  };
}

function readInfo(element: XmlElement | undefined): CharacterInfo {
  const attributes = element?.attributes ?? {};
  const text = (name: string): string => (element === undefined ? '' : (childNamed(element, name)?.text ?? ''));
  return {
    characterName: attributes['CHARACTER_NAME'] ?? '',
    alternateIdentities: attributes['ALTERNATE_IDENTITIES'] ?? '',
    playerName: attributes['PLAYER_NAME'] ?? '',
    campaignName: attributes['CAMPAIGN_NAME'] ?? '',
    genre: attributes['GENRE'] ?? '',
    gm: attributes['GM'] ?? '',
    height: attributes['HEIGHT'] ?? '',
    weight: attributes['WEIGHT'] ?? '',
    hairColor: attributes['HAIR_COLOR'] ?? '',
    eyeColor: attributes['EYE_COLOR'] ?? '',
    background: text('BACKGROUND'),
    personality: text('PERSONALITY'),
    quote: text('QUOTE'),
    tactics: text('TACTICS'),
    campaignUse: text('CAMPAIGN_USE'),
    appearance: text('APPEARANCE'),
    notes: [text('NOTES1'), text('NOTES2'), text('NOTES3'), text('NOTES4'), text('NOTES5')],
  };
}

function readImage(element: XmlElement): CharacterImage {
  return {
    fileName: element.attributes['FileName'] ?? '',
    filePath: element.attributes['FilePath'] ?? '',
    // Stored as Base64 in a CDATA section, wrapped across lines.
    base64: element.text.replace(/\s+/g, ''),
  };
}

function toAbility(element: XmlElement): Ability {
  const attributes = element.attributes;
  const adders: Ability[] = [];
  const modifiers: Ability[] = [];
  const children: Ability[] = [];
  let notes = '';

  for (const child of element.children) {
    switch (child.name) {
      case NOTES_ELEMENT:
        notes = child.text;
        break;
      case ADDER_ELEMENT:
        adders.push(toAbility(child));
        break;
      case MODIFIER_ELEMENT:
        modifiers.push(toAbility(child));
        break;
      default:
        children.push(toAbility(child));
    }
  }

  const parentId = attributes['PARENTID'];
  return {
    element: element.name,
    // Characteristics repeat their name as XMLID; anything without one falls
    // back to the tag, which is how the rules data keys them too.
    xmlId: attributes['XMLID'] ?? element.name,
    id: attributes['ID'] ?? '',
    ...(parentId === undefined ? {} : { parentId }),
    alias: attributes['ALIAS'] ?? '',
    name: attributes['NAME'] ?? '',
    levels: numberOr(attributes['LEVELS'], 0),
    baseCost: numberOr(attributes['BASECOST'], 0),
    position: numberOr(attributes['POSITION'], 0),
    attributes,
    notes,
    adders,
    modifiers,
    children,
  };
}

/** Numbers are decimal strings and may be fractional: `3.0`, `-0.25`. */
function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Booleans are the strings `Yes` and `No`. */
export function isYes(value: string | undefined): boolean {
  return value?.toLowerCase() === 'yes';
}

/**
 * Splits a section into standalone entries and the slots belonging to each
 * framework. Multipower and Elemental Control slots are stored as siblings of
 * the framework, linked by `PARENTID`, not nested inside it.
 */
export function groupByFramework(abilities: readonly Ability[]): {
  readonly standalone: readonly Ability[];
  readonly slotsByFrameworkId: ReadonlyMap<string, readonly Ability[]>;
} {
  const slotsByFrameworkId = new Map<string, Ability[]>();
  const standalone: Ability[] = [];
  const ids = new Set(abilities.map((ability) => ability.id));

  for (const ability of abilities) {
    // A PARENTID pointing outside this section belongs to nothing we can group,
    // so the entry stands on its own rather than disappearing.
    if (ability.parentId !== undefined && ids.has(ability.parentId)) {
      const slots = slotsByFrameworkId.get(ability.parentId);
      if (slots === undefined) {
        slotsByFrameworkId.set(ability.parentId, [ability]);
      } else {
        slots.push(ability);
      }
    } else {
      standalone.push(ability);
    }
  }

  return { standalone, slotsByFrameworkId };
}
