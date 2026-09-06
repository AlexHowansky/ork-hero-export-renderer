import { InvalidFileError } from '../util/errors.ts';

/**
 * Turns the bytes of a character file into text.
 *
 * This needs care. HERO Designer writes `.hdc` files as UTF-16 **big** endian
 * with a byte-order mark, while the XML declaration inside says only
 * `encoding="UTF-16"` — so trusting the declaration, or assuming the
 * little-endian default that most tools use, yields mojibake for every
 * character in the file. The byte-order mark is the authority.
 */

export type DetectedEncoding = 'utf-8' | 'utf-16be' | 'utf-16le';

export interface DecodeResult {
  readonly text: string;
  readonly encoding: DetectedEncoding;
  /** Whether the encoding came from a byte-order mark or had to be guessed. */
  readonly fromByteOrderMark: boolean;
}

export function decodeCharacterFile(bytes: Uint8Array, source?: string): DecodeResult {
  const detected = detectEncoding(bytes, source);
  return { ...detected, text: decode(bytes, detected.encoding, detected.fromByteOrderMark) };
}

function detectEncoding(
  bytes: Uint8Array,
  source?: string,
): { encoding: DetectedEncoding; fromByteOrderMark: boolean } {
  if (bytes.length === 0) {
    throw new InvalidFileError(
      'This file is empty. Please choose a character file saved by HERO Designer.',
      source === undefined ? {} : { source },
    );
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', fromByteOrderMark: true };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', fromByteOrderMark: true };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', fromByteOrderMark: true };
  }

  // No mark. UTF-16 without one still gives itself away: XML must begin with
  // "<", so one half of the first code unit is a zero byte.
  if (bytes[0] === 0x00 && bytes[1] !== 0x00) {
    return { encoding: 'utf-16be', fromByteOrderMark: false };
  }
  if (bytes[1] === 0x00 && bytes[0] !== 0x00) {
    return { encoding: 'utf-16le', fromByteOrderMark: false };
  }
  return { encoding: 'utf-8', fromByteOrderMark: false };
}

function decode(bytes: Uint8Array, encoding: DetectedEncoding, hasMark: boolean): string {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(bytes).toString('utf8').slice(hasMark ? 1 : 0);
    case 'utf-16le':
      return decodeUtf16(bytes, false, hasMark);
    case 'utf-16be':
      return decodeUtf16(bytes, true, hasMark);
  }
}

/**
 * Node and Bun decode UTF-16 little endian but not big endian, so big-endian
 * input is byte-swapped first. `swap16` needs an even length and its own copy,
 * since the caller's bytes may be a view onto a larger buffer.
 */
function decodeUtf16(bytes: Uint8Array, bigEndian: boolean, hasMark: boolean): string {
  const usable = bytes.length - (bytes.length % 2);
  const buffer = Buffer.from(bytes.subarray(0, usable));
  return (bigEndian ? buffer.swap16() : buffer).toString('utf16le').slice(hasMark ? 1 : 0);
}
