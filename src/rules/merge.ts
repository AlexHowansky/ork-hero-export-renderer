import { RulesError } from '../util/errors.ts';
import { silentLogger, type Logger } from '../util/logger.ts';
import { editionForTemplateId } from './hdt.ts';
import {
  SECTION_NAMES,
  type RuleNode,
  type RuleSection,
  type RuleSystem,
  type RuleTemplate,
  type SectionName,
} from './types.ts';

/**
 * Applies a template's `extends` chain, reproducing HERO Designer's own merge.
 *
 * Within each section, an entry is identified by `XMLID` when it has one and by
 * its tag name otherwise. A child template may then do three things:
 *
 *   * `<REMOVE>KEY</REMOVE>` deletes the parent's entry outright.
 *   * An entry whose key already exists overrides it: attributes are merged
 *     one by one, and the child's children replace the parent's wholesale.
 *     (`Automaton6E.hdt` relies on the attribute merge — it redefines `EGO`
 *     with new cost attributes while inheriting the rest.)
 *   * An entry with a new key is appended.
 *
 * Section attributes merge the same way, which matters for `MAINAPP`:
 * `Computer6E.hdt` overrides `HEIGHT` and `WEIGHT` but says nothing about
 * `NCM_COST_MULTIPLIER`, and must keep the parent's value.
 */
export function resolveSystem(
  id: string,
  templates: ReadonlyMap<string, RuleTemplate>,
  logger: Logger = silentLogger,
): RuleSystem {
  const chain = buildChain(id, templates);

  const sections = {} as Record<SectionName, RuleSection>;
  for (const name of SECTION_NAMES) {
    sections[name] = { entries: [] };
  }
  let attributes: Record<string, string> = {};

  for (const template of chain) {
    attributes = { ...attributes, ...template.attributes };
    for (const name of SECTION_NAMES) {
      sections[name] = mergeSection(
        sections[name],
        template.sections[name],
        template.removals?.[name] ?? [],
        template.file,
        name,
        logger,
      );
    }
  }

  return {
    id,
    chain: chain.map((template) => template.id),
    edition: editionForTemplateId(chain[0]?.id ?? id),
    attributes,
    sections,
  };
}

/** Root-first list of templates, e.g. `[Main, Superheroic]`. */
function buildChain(id: string, templates: ReadonlyMap<string, RuleTemplate>): RuleTemplate[] {
  const chain: RuleTemplate[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;

  while (current !== undefined) {
    if (seen.has(current)) {
      throw new RulesError(
        `The game system "${id}" extends itself through "${current}", so its rules cannot be assembled.`,
      );
    }
    seen.add(current);
    const template = templates.get(current);
    if (template === undefined) {
      const known = [...templates.keys()].sort().join(', ');
      throw new RulesError(
        current === id
          ? `Unknown game system "${id}". The available systems are: ${known}.`
          : `The game system "${id}" extends "${current}", which is missing from the rules data. ` +
            'Re-run the rules extraction against your HERO Designer jar.',
      );
    }
    chain.push(template);
    current = template.extends;
  }

  return chain.reverse();
}

function mergeSection(
  base: RuleSection,
  overlay: RuleSection | undefined,
  removals: readonly string[],
  sourceFile: string,
  sectionName: SectionName,
  logger: Logger,
): RuleSection {
  let entries = [...base.entries];

  for (const key of removals) {
    // HERO Designer's own files carry stale removals: the sixth-edition systems
    // still say <REMOVE>NCM</REMOVE> even though Main6E.hdt no longer defines
    // NCM. It ignores those, so we do too.
    const before = entries.length;
    entries = entries.filter((entry) => entry.id !== key);
    if (entries.length === before) {
      logger.debug(
        `${sourceFile}: ignoring <REMOVE>${key}</REMOVE> in ${sectionName}; the parent does not define it`,
      );
    }
  }

  // An id alone is not unique. All 53 martial maneuvers carry XMLID="MANEUVER"
  // and are told apart by DISPLAY, and POWERS holds both a MINDSCAN power and a
  // <SENSE XMLID="MINDSCAN">. So entries stay an ordered list: an overlay entry
  // overrides a *parent* entry with the same element and id, and anything else
  // is appended.
  const index = new Map<string, number>();
  entries.forEach((entry, i) => {
    const key = mergeKey(entry);
    if (!index.has(key)) {
      index.set(key, i);
    }
  });

  const overridden = new Set<string>();
  for (const entry of overlay?.entries ?? []) {
    const key = mergeKey(entry);
    const at = index.get(key);
    if (at === undefined || overridden.has(key)) {
      // Claim the key for this pass so the template's *own* later duplicates
      // are appended too, rather than overwriting the one just added.
      overridden.add(key);
      index.set(key, entries.length);
      entries.push(entry);
      continue;
    }
    entries[at] = overrideNode(entries[at] as RuleNode, entry);
    overridden.add(key);
  }

  const attributes = { ...base.attributes, ...overlay?.attributes };
  const merged: RuleSection = { entries };
  return Object.keys(attributes).length > 0 ? { ...merged, attributes } : merged;
}

/** Element name plus id: an id on its own is not unique within a section. */
function mergeKey(entry: RuleNode): string {
  return `${entry.element}\u0000${entry.id}`;
}

/** Attributes merge key by key; children and text replace outright. */
function overrideNode(base: RuleNode, overlay: RuleNode): RuleNode {
  const attributes = { ...base.attributes, ...overlay.attributes };
  const text = overlay.text ?? base.text;
  const children = overlay.children ?? base.children;
  return {
    element: overlay.element,
    id: overlay.id,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(text === undefined ? {} : { text }),
    ...(children === undefined ? {} : { children }),
  };
}

/**
 * Indexes a resolved section by entry id for lookup during rendering. Ids are
 * not unique — martial maneuvers all share one — so each maps to a list, in
 * document order.
 */
export function indexSection(section: RuleSection): ReadonlyMap<string, readonly RuleNode[]> {
  const index = new Map<string, RuleNode[]>();
  for (const entry of section.entries) {
    const bucket = index.get(entry.id);
    if (bucket === undefined) {
      index.set(entry.id, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return index;
}
