import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { packageVersion } from '../src/util/version.ts';

describe('packageVersion', () => {
  test('reports what package.json declares', () => {
    const declared = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
    expect(packageVersion()).toBe(declared);
  });

  test('reports something version-shaped, so a bug report can quote it', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
