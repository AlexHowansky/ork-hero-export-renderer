import { InvalidFileError } from '../util/errors.ts';

export interface XmlElement {
  /** Tag name, verbatim. HERO files are consistently SCREAMING_SNAKE_CASE. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /**
   * Concatenated character data directly inside this element, including CDATA
   * sections, with entity references resolved. Neither HERO format uses mixed
   * content, so this is either an element's text or empty.
   */
  readonly text: string;
  /** 1-based line of the element's opening tag, for error messages. */
  readonly line: number;
}

export interface ParseXmlOptions {
  /** File name used in error messages. */
  readonly source?: string;
  /** Guards against pathologically nested documents. */
  readonly maxDepth?: number;
  /** Guards against element-count blowups. */
  readonly maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 100;
const DEFAULT_MAX_NODES = 5_000_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

interface MutableElement {
  name: string;
  attributes: Record<string, string>;
  children: MutableElement[];
  text: string;
  line: number;
}

/**
 * A deliberately small XML reader for the two HERO formats.
 *
 * It supports exactly what those formats use — elements, attributes, character
 * data, CDATA, comments, and the XML declaration — and rejects everything else.
 * Most importantly it rejects `<!DOCTYPE>` outright, so there is no entity
 * substitution of any kind and therefore no XXE or entity-expansion exposure.
 * Character files routinely arrive from other people's machines, so that
 * guarantee is worth more here than general-purpose XML support.
 */
export function parseXml(source: string, options: ParseXmlOptions = {}): XmlElement {
  return new XmlParser(source, options).parse();
}

class XmlParser {
  private pos = 0;
  private line = 1;
  private nodes = 0;
  private readonly maxDepth: number;
  private readonly maxNodes: number;

  constructor(
    private readonly input: string,
    private readonly options: ParseXmlOptions,
  ) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  }

  parse(): XmlElement {
    let root: MutableElement | undefined;
    const stack: MutableElement[] = [];

    while (this.pos < this.input.length) {
      const lt = this.input.indexOf('<', this.pos);
      if (lt === -1) {
        this.consumeTextTo(this.input.length, stack);
        break;
      }
      this.consumeTextTo(lt, stack);

      if (this.startsWith('<!--')) {
        this.skipTo('-->', 'an unterminated comment');
      } else if (this.startsWith('<![CDATA[')) {
        this.readCdata(stack);
      } else if (this.startsWith('<?')) {
        this.skipTo('?>', 'an unterminated processing instruction');
      } else if (this.startsWith('<!DOCTYPE') || this.startsWith('<!ENTITY')) {
        // Refusing this is the whole XXE defence; do not soften it.
        throw this.fail(
          'This file contains a document type or entity declaration, which is not allowed. ' +
            'HERO Designer never produces these, so the file may be corrupt or may have been tampered with.',
        );
      } else if (this.startsWith('</')) {
        this.readCloseTag(stack);
      } else {
        const element = this.readOpenTag();
        if (stack.length >= this.maxDepth) {
          throw this.fail(`This file nests elements more than ${this.maxDepth} levels deep, which is not supported.`);
        }
        if (++this.nodes > this.maxNodes) {
          throw this.fail(`This file contains more than ${this.maxNodes} elements, which is not supported.`);
        }
        const parent = stack[stack.length - 1];
        if (parent === undefined) {
          if (root !== undefined) {
            throw this.fail('This file has more than one top-level element, which is not valid XML.');
          }
          root = element.node;
        } else {
          parent.children.push(element.node);
        }
        if (!element.selfClosing) {
          stack.push(element.node);
        }
      }
    }

    const unclosed = stack[stack.length - 1];
    if (unclosed !== undefined) {
      throw this.fail(`The element <${unclosed.name}> opened on line ${unclosed.line} is never closed.`);
    }
    if (root === undefined) {
      throw this.fail('This file contains no XML elements.');
    }
    return root;
  }

  /** Character data between tags. Only kept when it is inside an element. */
  private consumeTextTo(end: number, stack: MutableElement[]): void {
    if (end <= this.pos) {
      return;
    }
    const raw = this.input.slice(this.pos, end);
    this.advanceTo(end);
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.text += decodeEntities(raw);
    }
  }

  private readCdata(stack: MutableElement[]): void {
    const start = this.pos + '<![CDATA['.length;
    const end = this.input.indexOf(']]>', start);
    if (end === -1) {
      throw this.fail('This file contains an unterminated CDATA section.');
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      // CDATA is literal: no entity decoding.
      parent.text += this.input.slice(start, end);
    }
    this.advanceTo(end + ']]>'.length);
  }

  private readCloseTag(stack: MutableElement[]): void {
    const end = this.input.indexOf('>', this.pos);
    if (end === -1) {
      throw this.fail('This file contains an unterminated closing tag.');
    }
    const name = this.input.slice(this.pos + 2, end).trim();
    const open = stack.pop();
    if (open === undefined) {
      throw this.fail(`Found a closing tag </${name}> with no matching opening tag.`);
    }
    if (open.name !== name) {
      throw this.fail(
        `Found a closing tag </${name}>, but the innermost open element is <${open.name}> from line ${open.line}.`,
      );
    }
    this.advanceTo(end + 1);
  }

  private readOpenTag(): { node: MutableElement; selfClosing: boolean } {
    const line = this.line;
    let i = this.pos + 1;
    const nameStart = i;
    while (i < this.input.length && !isNameBreak(this.input.charCodeAt(i))) {
      i++;
    }
    const name = this.input.slice(nameStart, i);
    if (name.length === 0) {
      throw this.fail('Found a "<" that does not begin a valid element.');
    }

    const attributes: Record<string, string> = {};
    let selfClosing = false;

    for (;;) {
      i = this.skipSpaceFrom(i);
      if (i >= this.input.length) {
        throw this.fail(`The opening tag <${name}> is unterminated.`);
      }
      const ch = this.input[i];
      if (ch === '>') {
        i++;
        break;
      }
      if (ch === '/') {
        if (this.input[i + 1] !== '>') {
          throw this.fail(`The opening tag <${name}> contains a stray "/".`);
        }
        selfClosing = true;
        i += 2;
        break;
      }

      const attrStart = i;
      while (i < this.input.length && !isNameBreak(this.input.charCodeAt(i)) && this.input[i] !== '=') {
        i++;
      }
      const attrName = this.input.slice(attrStart, i);
      if (attrName.length === 0) {
        throw this.fail(`The opening tag <${name}> contains an unreadable attribute.`);
      }
      i = this.skipSpaceFrom(i);
      if (this.input[i] !== '=') {
        throw this.fail(`The attribute "${attrName}" on <${name}> has no value.`);
      }
      i = this.skipSpaceFrom(i + 1);
      const quote = this.input[i];
      if (quote !== '"' && quote !== "'") {
        throw this.fail(`The value of attribute "${attrName}" on <${name}> is not quoted.`);
      }
      const valueStart = ++i;
      const valueEnd = this.input.indexOf(quote, valueStart);
      if (valueEnd === -1) {
        throw this.fail(`The value of attribute "${attrName}" on <${name}> is unterminated.`);
      }
      // Attribute values legitimately span lines in HERO character files.
      attributes[attrName] = decodeEntities(this.input.slice(valueStart, valueEnd));
      i = valueEnd + 1;
    }

    this.advanceTo(i);
    return { node: { name, attributes, children: [], text: '', line }, selfClosing };
  }

  private skipSpaceFrom(i: number): number {
    while (i < this.input.length && isSpace(this.input.charCodeAt(i))) {
      i++;
    }
    return i;
  }

  private startsWith(prefix: string): boolean {
    return this.input.startsWith(prefix, this.pos);
  }

  private skipTo(terminator: string, description: string): void {
    const end = this.input.indexOf(terminator, this.pos);
    if (end === -1) {
      throw this.fail(`This file contains ${description}.`);
    }
    this.advanceTo(end + terminator.length);
  }

  /** Moves the cursor forward, keeping the line counter in step. */
  private advanceTo(end: number): void {
    for (let i = this.pos; i < end; i++) {
      if (this.input.charCodeAt(i) === 10) {
        this.line++;
      }
    }
    this.pos = end;
  }

  private fail(message: string): InvalidFileError {
    const options: { source?: string; line: number } = { line: this.line };
    if (this.options.source !== undefined) {
      options.source = this.options.source;
    }
    return new InvalidFileError(message, options);
  }
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isNameBreak(code: number): boolean {
  return isSpace(code) || code === 47 /* / */ || code === 62 /* > */;
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointOr(match, Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return codePointOr(match, Number.parseInt(body.slice(1), 10));
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function codePointOr(fallback: string, code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** First direct child with the given name, or undefined. */
export function childNamed(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** All direct children with the given name. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}
