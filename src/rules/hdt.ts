import { parseXml, type XmlElement } from '../xml/parse.ts';
import { RulesError } from '../util/errors.ts';
import {
  isSectionName,
  RULES_FORMAT_VERSION,
  SECTION_NAMES,
  type Edition,
  type RuleNode,
  type RuleSection,
  type RuleTemplate,
  type SectionName,
} from './types.ts';

/** `extends="builtIn.Main.hdt"` names the parent; strip the decoration. */
const BUILT_IN_PREFIX = 'builtIn.';
const HDT_SUFFIX = '.hdt';

/** Elements that carry only UI help text and are never read by an export tag. */
const HELP_TEXT_ELEMENTS = new Set(['DEFINITION', 'EXAMPLE']);

export interface CompileOptions {
  /**
   * Drop `<DEFINITION>` and `<EXAMPLE>` prose. These exist for HERO Designer's
   * own help panes; no export tag reads them, and they are most of the bulk.
   */
  readonly dropHelpText?: boolean;
}

/** Turns one `.hdt` file's XML into its unmerged JSON form. */
export function compileTemplate(xml: string, fileName: string, options: CompileOptions = {}): RuleTemplate {
  const root = parseXml(xml, { source: fileName });
  if (root.name !== 'TEMPLATE') {
    throw new RulesError(
      `Expected this file to start with a <TEMPLATE> element, but found <${root.name}>. ` +
        'It does not look like a HERO Designer game system file.',
      { source: fileName },
    );
  }

  const id = templateIdFromFileName(fileName);
  const attributes: Record<string, string> = { ...root.attributes };
  const parent = attributes['extends'];
  delete attributes['extends'];

  const sections: Partial<Record<SectionName, RuleSection>> = {};
  const removals: Partial<Record<SectionName, string[]>> = {};

  for (const child of root.children) {
    if (!isSectionName(child.name)) {
      throw new RulesError(
        `Found an unexpected section <${child.name}>. Expected one of: ${SECTION_NAMES.join(', ')}.`,
        { source: fileName, line: child.line },
      );
    }
    const { entries, removed } = readSection(child, options);
    const section: RuleSection = hasKeys(child.attributes)
      ? { attributes: { ...child.attributes }, entries }
      : { entries };
    sections[child.name] = section;
    if (removed.length > 0) {
      removals[child.name] = removed;
    }
  }

  const template: RuleTemplate = {
    formatVersion: RULES_FORMAT_VERSION,
    id,
    file: fileName,
    sections,
    ...(parent === undefined ? {} : { extends: templateIdFromReference(parent, fileName) }),
    ...(hasKeys(attributes) ? { attributes } : {}),
    ...(hasKeys(removals) ? { removals } : {}),
  };
  return template;
}

function readSection(
  section: XmlElement,
  options: CompileOptions,
): { entries: RuleNode[]; removed: string[] } {
  const entries: RuleNode[] = [];
  const removed: string[] = [];
  for (const child of section.children) {
    if (child.name === 'REMOVE') {
      const key = child.text.trim();
      if (key.length === 0) {
        throw new RulesError('Found an empty <REMOVE> element, which does not name anything to remove.', {
          line: child.line,
        });
      }
      removed.push(key);
      continue;
    }
    const node = toRuleNode(child, options);
    if (node !== undefined) {
      entries.push(node);
    }
  }
  return { entries, removed };
}

function toRuleNode(element: XmlElement, options: CompileOptions): RuleNode | undefined {
  if (options.dropHelpText === true && HELP_TEXT_ELEMENTS.has(element.name)) {
    return undefined;
  }
  const children = element.children
    .map((child) => toRuleNode(child, options))
    .filter((child): child is RuleNode => child !== undefined);
  const text = element.text.trim();
  return {
    element: element.name,
    id: ruleNodeId(element.name, element.attributes),
    ...(hasKeys(element.attributes) ? { attributes: { ...element.attributes } } : {}),
    ...(text.length > 0 ? { text } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

export function ruleNodeId(elementName: string, attributes: Readonly<Record<string, string>>): string {
  const xmlId = attributes['XMLID'];
  return xmlId !== undefined && xmlId.length > 0 ? xmlId : elementName;
}

/** `Superheroic.hdt` -> `Superheroic`. */
export function templateIdFromFileName(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  return base.endsWith(HDT_SUFFIX) ? base.slice(0, -HDT_SUFFIX.length) : base;
}

/**
 * Resolves an `extends` or character-file `TEMPLATE` reference to a template id.
 * Both spell it `builtIn.Superheroic.hdt`; character files may also name a
 * custom file by path.
 */
export function templateIdFromReference(reference: string, source?: string): string {
  const trimmed = reference.trim();
  if (trimmed.length === 0) {
    throw new RulesError('Found an empty game system reference.', source === undefined ? {} : { source });
  }
  const withoutPrefix = trimmed.startsWith(BUILT_IN_PREFIX) ? trimmed.slice(BUILT_IN_PREFIX.length) : trimmed;
  return templateIdFromFileName(withoutPrefix.replace(/\\/g, '/'));
}

/**
 * Sixth-edition files are the ones whose chain roots at `Main6E`. Every shipped
 * system is named accordingly, so the id suffix is a reliable signal.
 */
export function editionForTemplateId(id: string): Edition {
  return id.endsWith('6E') ? '6e' : '5e';
}

function hasKeys(record: Readonly<Record<string, unknown>>): boolean {
  for (const _ in record) {
    return true;
  }
  return false;
}
