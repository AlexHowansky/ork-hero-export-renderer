import { InvalidFileError } from '../util/errors.ts';
import { findContainerNames, tokenize, type Token } from './lexer.ts';
import type {
  ContainerNode,
  ParsedTemplate,
  Replacement,
  TemplateNode,
} from './ast.ts';

// Containers that describe the template rather than the character sheet
// (TEMPLATE_NAME, TEMPLATE_DESCRIPTION, FILE_EXTENSION) and those that declare
// a substitution to run over the finished document are all removed from the
// output, opening tag to closing tag, content included.
const REG_REPLACE = 'REG_REPLACE';
const REPLACE = 'REPLACE';
const REGSTRING = 'REGSTRING';
const REPSTRING = 'REPSTRING';
const DEFSTRING = 'DEFSTRING';

export interface ParseTemplateOptions {
  readonly source?: string;
}

export function parseTemplate(source: string, options: ParseTemplateOptions = {}): ParsedTemplate {
  const tokens = tokenize(source);
  const containerNames = findContainerNames(tokens);
  const nodes = buildTree(tokens, containerNames, options.source);

  let name = '';
  let description = '';
  const fileExtensions: string[] = [];
  const replacements: Replacement[] = [];

  const body = extract(nodes, (container) => {
    switch (container.name) {
      case 'TEMPLATE_NAME':
        name = textOf(container);
        return true;
      case 'TEMPLATE_DESCRIPTION':
        description = textOf(container);
        return true;
      case 'FILE_EXTENSION':
        fileExtensions.push(textOf(container).trim());
        return true;
      case REG_REPLACE:
      case REPLACE:
        replacements.push(readReplacement(container, options.source));
        return true;
      default:
        return false;
    }
  });

  return { name, description, fileExtensions, replacements, body };
}

function buildTree(
  tokens: readonly Token[],
  containerNames: ReadonlySet<string>,
  source?: string,
): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: { node: ContainerNode; children: TemplateNode[] }[] = [];
  const childrenOf = (): TemplateNode[] => stack[stack.length - 1]?.children ?? root;

  for (const token of tokens) {
    if (token.kind === 'text') {
      childrenOf().push({ kind: 'text', text: token.text });
      continue;
    }

    if (token.closing) {
      const open = stack.pop();
      if (open === undefined) {
        throw fail(`Found <!--/${token.name}--> with no matching <!--${token.name}--> before it.`, source, token.line);
      }
      if (open.node.name !== token.name) {
        throw fail(
          `Found <!--/${token.name}-->, but the container still open is <!--${open.node.name}--> ` +
            `from line ${open.node.line}.`,
          source,
          token.line,
        );
      }
      const closed: ContainerNode = { ...open.node, children: open.children, rawClose: token.raw };
      childrenOf().push(closed);
      continue;
    }

    if (!containerNames.has(token.name)) {
      childrenOf().push({ kind: 'tag', name: token.name, raw: token.raw, line: token.line });
      continue;
    }

    stack.push({
      node: {
        kind: 'container',
        name: token.name,
        children: [],
        rawOpen: token.raw,
        rawClose: `<!--/${token.name}-->`,
        line: token.line,
      },
      children: [],
    });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed !== undefined) {
    throw fail(
      `The container <!--${unclosed.node.name}--> opened on line ${unclosed.node.line} is never closed.`,
      source,
      unclosed.node.line,
    );
  }
  return root;
}

/**
 * Removes containers the caller claims, wherever they appear.
 *
 * The removal is a splice within the text, not a whole line: a template's first
 * line packs the metadata and the replacement rules together and then runs
 * straight into the banner comment, which has to stay.
 */
function extract(
  nodes: readonly TemplateNode[],
  claim: (container: ContainerNode) => boolean,
): TemplateNode[] {
  const kept: TemplateNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'container') {
      kept.push(node);
    } else if (!claim(node)) {
      kept.push({ ...node, children: extract(node.children, claim) });
    }
  }
  return kept;
}

function readReplacement(container: ContainerNode, source?: string): Replacement {
  const replacement = textOf(findChild(container, REPSTRING, source));

  if (container.name === REG_REPLACE) {
    return {
      kind: 'regex',
      pattern: textOf(findChild(container, REGSTRING, source)),
      replacement,
      line: container.line,
    };
  }
  return {
    kind: 'literal',
    find: textOf(findChild(container, DEFSTRING, source)),
    replacement,
    line: container.line,
  };
}

function findChild(container: ContainerNode, name: string, source?: string): ContainerNode {
  const child = container.children.find(
    (node): node is ContainerNode => node.kind === 'container' && node.name === name,
  );
  if (child === undefined) {
    throw fail(
      `The <!--${container.name}--> block is missing its <!--${name}--> part, so it cannot be applied.`,
      source,
      container.line,
    );
  }
  return child;
}

/** The literal text inside a container, ignoring any nested directives. */
function textOf(container: ContainerNode): string {
  return container.children
    .map((node) => (node.kind === 'text' ? node.text : ''))
    .join('');
}

function fail(message: string, source: string | undefined, line: number): InvalidFileError {
  return new InvalidFileError(message, source === undefined ? { line } : { source, line });
}
