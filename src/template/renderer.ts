import type { ParsedTemplate, TemplateNode } from './ast.ts';

/**
 * What the renderer needs to know to turn a parsed template into a sheet.
 *
 * Containers are handed a callback rather than their rendered body, so that one
 * interface covers all three kinds: a conditional calls it once or not at all,
 * a loop calls it once per item with its own scope pushed, and a transform such
 * as `<!--MATH-->` calls it and then works on the result.
 *
 * Returning `undefined` from either method means "I do not know this name". The
 * directive is then written out exactly as it appeared, which is what HERO
 * Designer does: `<!--PRIMARY_OMCV-->` is not in its tag table, and survives
 * verbatim into the exported sheet.
 */
export interface RenderContext {
  resolveTag(name: string): string | undefined;
  resolveContainer(name: string, renderBody: () => string): string | undefined;
}

export function renderNodes(nodes: readonly TemplateNode[], context: RenderContext): string {
  const parts: string[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        parts.push(node.text);
        break;
      case 'tag':
        parts.push(context.resolveTag(node.name) ?? node.raw);
        break;
      case 'container': {
        const renderBody = (): string => renderNodes(node.children, context);
        const resolved = context.resolveContainer(node.name, renderBody);
        // An unknown container keeps its markers and its rendered contents,
        // so nothing the template author wrote is silently dropped.
        parts.push(resolved ?? `${node.rawOpen}${renderBody()}${node.rawClose}`);
        break;
      }
    }
  }
  return parts.join('');
}

export function renderTemplate(template: ParsedTemplate, context: RenderContext): string {
  return renderNodes(template.body, context);
}

/**
 * Writes a parsed template back out unchanged apart from the metadata and
 * replacement blocks, which are always removed. Used to check that parsing
 * loses nothing.
 */
export const passThroughContext: RenderContext = {
  resolveTag: () => undefined,
  resolveContainer: () => undefined,
};
