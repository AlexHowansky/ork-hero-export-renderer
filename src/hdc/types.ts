/**
 * The parsed form of a `.hdc` character file.
 *
 * A character file records structure, not presentation: a skill is
 * `XMLID="ACTING" LEVELS="1" BASECOST="3.0"`, and the text and cost that end up
 * on the sheet are computed later against the game system's rules. So this
 * layer stays close to the file — every attribute is kept verbatim in
 * `attributes`, with named fields only for what is structural.
 */

export interface CharacterFile {
  /** The file-format version, e.g. `6.0`. Not the rules edition. */
  readonly version: string;
  /** Game system id from `TEMPLATE="builtIn.Superheroic.hdt"`. */
  readonly templateId: string;
  readonly configuration: BasicConfiguration;
  readonly info: CharacterInfo;
  readonly characteristics: readonly Ability[];
  readonly skills: readonly Ability[];
  readonly perks: readonly Ability[];
  readonly talents: readonly Ability[];
  readonly martialArts: readonly Ability[];
  readonly powers: readonly Ability[];
  readonly disadvantages: readonly Ability[];
  readonly equipment: readonly Ability[];
  /**
   * The `<RULES>` element: the campaign's own settings, kept verbatim. What a
   * piece of equipment costs is priced and written in the units named here.
   */
  readonly houseRules: Readonly<Record<string, string>>;
  readonly image?: CharacterImage;
}

export interface BasicConfiguration {
  readonly basePoints: number;
  readonly disadPoints: number;
  readonly experience: number;
  /** Path to the `.hde` last used, as recorded by HERO Designer. */
  readonly exportTemplate: string;
  readonly rules: string;
}

export interface CharacterInfo {
  readonly characterName: string;
  readonly alternateIdentities: string;
  readonly playerName: string;
  readonly campaignName: string;
  readonly genre: string;
  readonly gm: string;
  readonly height: string;
  readonly weight: string;
  readonly hairColor: string;
  readonly eyeColor: string;
  readonly background: string;
  readonly personality: string;
  readonly quote: string;
  readonly tactics: string;
  readonly campaignUse: string;
  readonly appearance: string;
  /** The five free-text note fields, in order; absent ones are empty strings. */
  readonly notes: readonly [string, string, string, string, string];
}

/**
 * One line on the character sheet: a characteristic, skill, power, disadvantage,
 * martial maneuver, or piece of equipment. They share an attribute vocabulary,
 * so one shape covers them all.
 */
export interface Ability {
  /** Tag name: `SKILL`, `POWER`, `MULTIPOWER`, `DISAD`, `STR`, … */
  readonly element: string;
  /** Rules key, matched against the game system data. */
  readonly xmlId: string;
  /**
   * Per-character identifier. Treat it as a handle, not a unique key: HERO
   * Designer reuses values across a file (Redshift's COM and LEAPING share one).
   * Only framework ids, which slots point at, are dependable.
   */
  readonly id: string;
  /** Set on a framework slot; names the `id` of its Multipower or similar. */
  readonly parentId?: string;
  /** Rules name, e.g. `Energy Blast`. */
  readonly alias: string;
  /** The player's own label for this item, often empty. */
  readonly name: string;
  readonly levels: number;
  readonly baseCost: number;
  readonly position: number;
  readonly attributes: Readonly<Record<string, string>>;
  readonly notes: string;
  readonly adders: readonly Ability[];
  readonly modifiers: readonly Ability[];
  /** Anything nested that is not an adder, modifier, or notes element. */
  readonly children: readonly Ability[];
}

export interface CharacterImage {
  readonly fileName: string;
  readonly filePath: string;
  /**
   * The picture, still Base64 as stored. Templates ask for it as hex or as a
   * data URL, so decoding is left until one of those tags actually runs.
   */
  readonly base64: string;
}
