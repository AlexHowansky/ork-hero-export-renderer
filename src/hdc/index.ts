/**
 * Reading HERO Designer character files, without reaching a Node API.
 *
 * See `../model/index.ts` for why this exists alongside the package root.
 */

export { parseCharacterFile, groupByFramework, isYes } from './parse.ts';
export { decodeCharacterFile, type DecodeResult, type DetectedEncoding } from './decode.ts';
export type {
  Ability,
  BasicConfiguration,
  CharacterFile,
  CharacterImage,
  CharacterInfo,
} from './types.ts';
