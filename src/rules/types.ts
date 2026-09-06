/**
 * The shape of the JSON we compile the `*.hdt` game-system files into.
 *
 * The `.hdt` data is irregular — powers, senses, language-similarity tables and
 * modifier option lists all have different inner shapes, nested up to five deep
 * — so we keep a faithful generic tree rather than inventing a taxonomy we
 * would have to keep widening. The one thing we derive is `id`, because that is
 * what both the merge rules and the character file key on.
 */

export const RULES_FORMAT_VERSION = 1;

/** The ten sections every `.hdt` declares, in HERO Designer's own order. */
export const SECTION_NAMES = [
  'MAINAPP',
  'CHARACTERISTICS',
  'SKILLS',
  'SKILL_ENHANCERS',
  'MARTIAL_ARTS',
  'PERKS',
  'TALENTS',
  'POWERS',
  'MODIFIERS',
  'DISADVANTAGES',
] as const;

export type SectionName = (typeof SECTION_NAMES)[number];

export interface RuleNode {
  /** The XML tag name, e.g. `SKILL`, `ABSORPTION`, `OPTION`. */
  readonly element: string;
  /**
   * Merge key: the `XMLID` attribute when present, otherwise the tag name.
   * Roughly half of the entries in `POWERS` and `CHARACTERISTICS` identify
   * themselves by tag name alone, so both forms are needed.
   */
  readonly id: string;
  readonly attributes?: Readonly<Record<string, string>>;
  /** Character data, present only on leaf-ish nodes such as `<SOURCE>`. */
  readonly text?: string;
  readonly children?: readonly RuleNode[];
}

export interface RuleSection {
  /** Attributes on the section element itself; only `MAINAPP` uses these. */
  readonly attributes?: Readonly<Record<string, string>>;
  readonly entries: readonly RuleNode[];
}

/**
 * One `.hdt` file, compiled but *not* merged with its parents. Resolution
 * happens at load time so that `Main.hdt`, which nine other systems extend, is
 * stored once instead of nine times.
 */
export interface RuleTemplate {
  readonly formatVersion: number;
  /** `Superheroic`, `Main6E`, … — the file's base name. */
  readonly id: string;
  readonly file: string;
  /** Parent template id, from `extends="builtIn.Main.hdt"`. */
  readonly extends?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly sections: Readonly<Partial<Record<SectionName, RuleSection>>>;
  /** Per-section lists of ids the file removes from its parent. */
  readonly removals?: Readonly<Partial<Record<SectionName, readonly string[]>>>;
}

/** A template with its whole `extends` chain applied. What the renderer uses. */
export interface RuleSystem {
  readonly id: string;
  /** Root-first, e.g. `["Main", "Superheroic"]`. */
  readonly chain: readonly string[];
  readonly edition: Edition;
  readonly attributes: Readonly<Record<string, string>>;
  readonly sections: Readonly<Record<SectionName, RuleSection>>;
}

export type Edition = '5e' | '6e';

export interface RulesManifest {
  readonly formatVersion: number;
  /** Where the data came from, so a stale bundle is identifiable. */
  readonly sourceJar: string;
  readonly extractedAt: string;
  readonly templates: readonly ManifestEntry[];
}

export interface ManifestEntry {
  readonly id: string;
  readonly file: string;
  readonly edition: Edition;
  readonly extends?: string;
  readonly helpTextIncluded: boolean;
}

export function isSectionName(value: string): value is SectionName {
  return (SECTION_NAMES as readonly string[]).includes(value);
}
