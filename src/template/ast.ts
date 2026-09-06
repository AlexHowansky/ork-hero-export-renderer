/**
 * Export templates are HTML with directives written as comments. There is only
 * one syntax:
 *
 *   `<!--NAME-->`                       a tag, replaced by a value
 *   `<!--NAME-->` … `<!--/NAME-->`      a container, whose body is conditional,
 *                                       repeated, or transformed
 *
 * No attributes, no parameters, no other delimiters. Anything between `<!--`
 * and `-->` that is not a bare uppercase name — the banner comment at the top
 * of a template, for instance — is ordinary text and is copied through.
 */

export type TemplateNode = TextNode | TagNode | ContainerNode;

export interface TextNode {
  readonly kind: 'text';
  readonly text: string;
}

export interface TagNode {
  readonly kind: 'tag';
  readonly name: string;
  /** The directive exactly as written, for tags the renderer does not know. */
  readonly raw: string;
  readonly line: number;
}

export interface ContainerNode {
  readonly kind: 'container';
  readonly name: string;
  readonly children: readonly TemplateNode[];
  readonly rawOpen: string;
  readonly rawClose: string;
  readonly line: number;
}

/** A whole-document substitution, applied once at the very end of a render. */
export type Replacement = RegexReplacement | LiteralReplacement;

export interface RegexReplacement {
  readonly kind: 'regex';
  /** A Java regular expression, as written in the template. */
  readonly pattern: string;
  readonly replacement: string;
  readonly line: number;
}

export interface LiteralReplacement {
  readonly kind: 'literal';
  readonly find: string;
  readonly replacement: string;
  readonly line: number;
}

export interface ParsedTemplate {
  /** From `<!--TEMPLATE_NAME-->`; shown in HERO Designer's export list. */
  readonly name: string;
  readonly description: string;
  /** From `<!--FILE_EXTENSION-->`. A template may declare more than one. */
  readonly fileExtensions: readonly string[];
  readonly replacements: readonly Replacement[];
  /** The document, with the metadata and replacement blocks removed. */
  readonly body: readonly TemplateNode[];
}

export function isTextNode(node: TemplateNode): node is TextNode {
  return node.kind === 'text';
}
