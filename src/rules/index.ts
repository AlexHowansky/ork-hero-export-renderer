/**
 * Game system data: merging a template's `extends` chain, and the shapes it
 * produces.
 *
 * `load.ts` and `jar.ts` are deliberately absent. They read the filesystem and
 * unzip a jar, which is build-time work; including them here would defeat the
 * purpose of this entry point. Compile the rules with the `extract-rules` CLI,
 * then hand the resulting JSON to `resolveSystem`.
 */

export { resolveSystem, indexSection } from './merge.ts';
export {
  RULES_FORMAT_VERSION,
  SECTION_NAMES,
  isSectionName,
  type Edition,
  type ManifestEntry,
  type RuleNode,
  type RuleSection,
  type RuleSystem,
  type RuleTemplate,
  type RulesManifest,
  type SectionName,
} from './types.ts';
