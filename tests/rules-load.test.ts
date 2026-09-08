import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RULES_ENV_VAR,
  RulesLibrary,
  defaultRulesDirectory,
  rulesDirectoryCandidates,
} from '../src/rules/load.ts';

const original = process.env[RULES_ENV_VAR];

afterEach(() => {
  if (original === undefined) {
    delete process.env[RULES_ENV_VAR];
  } else {
    process.env[RULES_ENV_VAR] = original;
  }
});

/** A directory that looks like extracted rules, as far as the search is concerned. */
function rulesDir(formatVersion = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'ork-rules-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ formatVersion, templates: [] }));
  return dir;
}

describe('rules directory search', () => {
  test('looks in the working directory, which is where extract-rules writes', () => {
    delete process.env[RULES_ENV_VAR];
    expect(rulesDirectoryCandidates()).toContain(resolve('rules'));
  });

  test('tries the environment variable first', () => {
    const dir = rulesDir();
    process.env[RULES_ENV_VAR] = dir;
    expect(rulesDirectoryCandidates()[0]).toBe(dir);
  });

  test('ignores the environment variable when it is empty', () => {
    process.env[RULES_ENV_VAR] = '';
    expect(rulesDirectoryCandidates()).not.toContain('');
  });

  test('names each directory once, even when two candidates coincide', () => {
    process.env[RULES_ENV_VAR] = resolve('rules');
    const candidates = rulesDirectoryCandidates();
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test('picks the first candidate that actually holds rules', () => {
    const dir = rulesDir();
    process.env[RULES_ENV_VAR] = dir;
    expect(defaultRulesDirectory()).toBe(dir);
  });

  test('falls back to a path inside the package when nothing holds rules', () => {
    process.env[RULES_ENV_VAR] = mkdtempSync(join(tmpdir(), 'ork-empty-'));
    expect(defaultRulesDirectory()).not.toBe(process.env[RULES_ENV_VAR]);
  });
});

/** The error from a load that must fail; also asserts that it did. */
async function loadError(directory: string): Promise<Error> {
  try {
    await RulesLibrary.load(directory);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`Expected loading rules from ${directory} to fail, but it did not.`);
}

describe('missing rules data', () => {
  test('says where it looked and how to fix it', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ork-empty-'));
    const error = await loadError(empty);
    expect(error.message).toContain('Looked in:');
    expect(error.message).toContain(empty);
    expect(error.message).toContain('ork-hero-extract-rules');
    expect(error.message).toContain(RULES_ENV_VAR);
  });

  test('names only the directory it was given, not the ones it would have tried', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ork-empty-'));
    const error = await loadError(empty);
    expect(error.message).not.toContain(resolve('rules'));
  });

  // A directory reached through the search order still loads: this checkout
  // keeps its extracted rules where `extract-rules` put them, same as a
  // consumer's project would.
  test('finds rules through the search order when given no directory', async () => {
    process.env[RULES_ENV_VAR] = mkdtempSync(join(tmpdir(), 'ork-empty-'));
    expect((await RulesLibrary.load()).systemIds.length).toBeGreaterThan(0);
  });
});
