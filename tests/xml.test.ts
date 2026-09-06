import { describe, expect, test } from 'bun:test';
import { childNamed, childrenNamed, parseXml } from '../src/xml/parse.ts';
import { InvalidFileError } from '../src/util/errors.ts';

describe('parseXml', () => {
  test('reads elements, attributes and text', () => {
    const root = parseXml('<A X="1"><B>hi</B><B>there</B></A>');
    expect(root.name).toBe('A');
    expect(root.attributes).toEqual({ X: '1' });
    expect(childrenNamed(root, 'B').map((b) => b.text)).toEqual(['hi', 'there']);
  });

  test('handles self-closing elements', () => {
    const root = parseXml('<A><NOTES /><B/></A>');
    expect(root.children.map((c) => c.name)).toEqual(['NOTES', 'B']);
    expect(childNamed(root, 'NOTES')?.children).toEqual([]);
  });

  test('resolves named and numeric entities', () => {
    const root = parseXml('<A T="Elias &quot;Eli&quot; Mercer">5 &lt; 6 &amp; 7 &#65; &#x42;</A>');
    expect(root.attributes['T']).toBe('Elias "Eli" Mercer');
    expect(root.text).toBe('5 < 6 & 7 A B');
  });

  test('leaves unknown entities alone rather than dropping them', () => {
    expect(parseXml('<A>&nbsp;</A>').text).toBe('&nbsp;');
  });

  test('treats CDATA as literal', () => {
    const root = parseXml('<A><![CDATA[<b>&amp;</b>]]></A>');
    expect(root.text).toBe('<b>&amp;</b>');
  });

  test('allows newlines inside attribute values, as character files do', () => {
    const root = parseXml('<A COMMENTS="line one\nline two">x</A>');
    expect(root.attributes['COMMENTS']).toBe('line one\nline two');
  });

  test('skips comments and the XML declaration', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><A>x</A>');
    expect(root.name).toBe('A');
    expect(root.text).toBe('x');
  });

  // The XXE defence. Entity declarations are never resolved because a document
  // that contains any is refused outright.
  test('rejects DOCTYPE and ENTITY declarations', () => {
    const xxe =
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><A>&xxe;</A>';
    expect(() => parseXml(xxe, { source: 'evil.hdc' })).toThrow(InvalidFileError);
    expect(() => parseXml(xxe)).toThrow(/document type or entity declaration/);
  });

  test('reports the line of an unclosed element', () => {
    expect(() => parseXml('<A>\n<B>\n</A>')).toThrow(/<B>.*line 2/);
  });

  test('rejects two top-level elements', () => {
    expect(() => parseXml('<A/><B/>')).toThrow(/more than one top-level element/);
  });

  test('rejects unquoted attribute values', () => {
    expect(() => parseXml('<A X=1/>')).toThrow(/not quoted/);
  });

  test('enforces the depth cap', () => {
    const deep = '<A>'.repeat(20) + '</A>'.repeat(20);
    expect(() => parseXml(deep, { maxDepth: 5 })).toThrow(/more than 5 levels deep/);
  });

  test('names the source file in errors', () => {
    try {
      parseXml('<A>', { source: 'Broken.hdt' });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('in Broken.hdt');
    }
  });
});
