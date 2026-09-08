/**
 * The rules calculations, as an entry point that reaches no Node API.
 *
 * The package root re-exports these too, but it also reaches `rules/load`,
 * `rules/jar` and `render`, which import `node:fs`, `node:zlib` and `node:path`.
 * A bundler resolves every import in that barrel before it works out which are
 * used, so browser builds fail on the root even when they only want arithmetic.
 * Importing `ork-hero-export-renderer/model` avoids that by construction.
 */

export * from './numbers.ts';
export * from './characteristics.ts';
export * from './modifiers.ts';
export * from './abilities.ts';
export * from './powers.ts';
export * from './points.ts';
export * from './defenses.ts';
export * from './size.ts';
export * from './equipment.ts';
