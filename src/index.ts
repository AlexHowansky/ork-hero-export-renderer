/**
 * HERO Export Renderer.
 *
 * Applies a HERO Designer export template (`*.hde`) to a character file
 * (`*.hdc`) to produce an HTML character sheet, reproducing what HERO Designer
 * itself does when you export a character.
 *
 * The quickest way in is `renderFiles`, which takes the two paths and gives
 * back the finished HTML. Everything it uses is exported too, so a caller can
 * take the pipeline apart — read a character, inspect the computed sheet, swap
 * the rules data — without reimplementing any of it.
 */

export {
  render,
  renderFiles,
  renderToFile,
  type RenderOptions,
} from './render.ts';

export { HeroError, InvalidFileError, RulesError } from './util/errors.ts';
export { consoleLogger, silentLogger, type Logger, type LogLevel } from './util/logger.ts';

export {
  parseXml,
  normalizeLineEndings,
  childNamed,
  childrenNamed,
  type XmlElement,
  type ParseXmlOptions,
} from './xml/parse.ts';

export { parseCharacterFile, groupByFramework, isYes } from './hdc/parse.ts';
export { decodeCharacterFile, type DecodeResult, type DetectedEncoding } from './hdc/decode.ts';
export type {
  Ability,
  BasicConfiguration,
  CharacterFile,
  CharacterImage,
  CharacterInfo,
} from './hdc/types.ts';

export { parseTemplate, type ParseTemplateOptions } from './template/parser.ts';
export { tokenize, findContainerNames, type Token, type TextToken, type DirectiveToken } from './template/lexer.ts';
export {
  applyReplacements,
  translatePattern,
  translateReplacement,
  type PostProcessOptions,
} from './template/postprocess.ts';
export {
  renderTemplate,
  renderNodes,
  passThroughContext,
  type RenderContext,
} from './template/renderer.ts';
export {
  isTextNode,
  type ContainerNode,
  type LiteralReplacement,
  type ParsedTemplate,
  type RegexReplacement,
  type Replacement,
  type TagNode,
  type TemplateNode,
  type TextNode,
} from './template/ast.ts';

export * from './model/numbers.ts';
export * from './model/characteristics.ts';
export * from './model/modifiers.ts';
export * from './model/abilities.ts';
export * from './model/powers.ts';
export * from './model/points.ts';
export * from './model/defenses.ts';
export * from './model/size.ts';
export * from './model/equipment.ts';

export { buildSheet, type Sheet, type BuildSheetOptions } from './tags/sheet.ts';
export { createContext, formatTimestamp, type ContextOptions } from './tags/context.ts';
export { evaluateMath } from './tags/math.ts';

export {
  RulesLibrary,
  defaultRulesDirectory,
  rulesDirectoryCandidates,
  RULES_ENV_VAR,
} from './rules/load.ts';
export { resolveSystem, indexSection } from './rules/merge.ts';
export {
  compileTemplate,
  editionForTemplateId,
  ruleNodeId,
  templateIdFromFileName,
  templateIdFromReference,
  type CompileOptions,
} from './rules/hdt.ts';
export { ZipArchive, type ZipEntry } from './rules/jar.ts';
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
} from './rules/types.ts';
