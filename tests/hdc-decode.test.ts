import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decodeCharacterFile } from '../src/hdc/decode.ts';
import { InvalidFileError } from '../src/util/errors.ts';

function encode(text: string, encoding: 'utf-16be' | 'utf-16le' | 'utf-8', bom: boolean): Uint8Array {
  if (encoding === 'utf-8') {
    const body = Buffer.from(text, 'utf8');
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  const le = Buffer.from(bom ? `﻿${text}` : text, 'utf16le');
  return encoding === 'utf-16le' ? le : Buffer.from(le).swap16();
}

describe('decodeCharacterFile', () => {
  // The case that matters: HERO Designer writes UTF-16 big endian, while the
  // XML declaration inside claims only "UTF-16".
  test('reads the real character file as UTF-16 big endian', () => {
    const result = decodeCharacterFile(readFileSync('fixtures/Redshift.hdc'), 'Redshift.hdc');
    expect(result.encoding).toBe('utf-16be');
    expect(result.fromByteOrderMark).toBe(true);
    expect(result.text).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
    expect(result.text).toContain('<CHARACTER version="6.0" TEMPLATE="builtIn.Superheroic.hdt">');
  });

  test.each([
    ['utf-16be', true],
    ['utf-16le', true],
    ['utf-8', true],
    ['utf-16be', false],
    ['utf-16le', false],
    ['utf-8', false],
  ] as const)('round-trips %s (byte-order mark: %p)', (encoding, bom) => {
    const text = '<CHARACTER NAME="Elias “Eli” Mercer"/>';
    const result = decodeCharacterFile(encode(text, encoding, bom));
    expect(result.text).toBe(text);
    expect(result.encoding).toBe(encoding);
    expect(result.fromByteOrderMark).toBe(bom);
  });

  test('strips the byte-order mark rather than leaving it in the text', () => {
    expect(decodeCharacterFile(encode('<A/>', 'utf-16be', true)).text[0]).toBe('<');
  });

  test('tolerates a trailing odd byte instead of throwing', () => {
    const bytes = Buffer.concat([encode('<A/>', 'utf-16be', true), Buffer.from([0x00])]);
    expect(decodeCharacterFile(bytes).text).toBe('<A/>');
  });

  test('explains an empty file', () => {
    expect(() => decodeCharacterFile(new Uint8Array(0), 'empty.hdc')).toThrow(InvalidFileError);
    expect(() => decodeCharacterFile(new Uint8Array(0))).toThrow(/file is empty/);
  });
});
