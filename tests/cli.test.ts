import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/render.ts';
import { render, renderFiles, renderToFile } from '../src/render.ts';
import { HeroError } from '../src/util/errors.ts';
import { silentLogger } from '../src/util/logger.ts';

const CHARACTER = 'fixtures/Redshift.hdc';
const TEMPLATE = 'fixtures/Ork-16x9.hde';
const CLI = 'src/cli/render.ts';

/**
 * The sheet's save timestamp is the character file's own modification time,
 * written in local time — which is what HERO Designer does. Reproducing the
 * reference sheet therefore means running in the zone it was exported from, so
 * these tests pin it rather than depending on the machine.
 */
const EXPORT_ZONE = 'America/New_York';

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TZ: EXPORT_ZONE },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe('parseArgs', () => {
  test('takes two required files and an optional third', () => {
    expect(parseArgs(['a.hdc', 'b.hde'])).toMatchObject({
      characterPath: 'a.hdc',
      templatePath: 'b.hde',
      outputPath: undefined,
      strict: true,
    });
    expect(parseArgs(['a.hdc', 'b.hde', 'out.html'])).toMatchObject({ outputPath: 'out.html' });
  });

  test('reads the options', () => {
    expect(parseArgs(['a.hdc', 'b.hde', '--no-strict'])).toMatchObject({ strict: false });
    expect(parseArgs(['a.hdc', 'b.hde', '-v'])).toMatchObject({ logLevel: 'debug' });
    expect(parseArgs(['a.hdc', 'b.hde', '-q'])).toMatchObject({ logLevel: 'error' });
    expect(parseArgs(['a.hdc', 'b.hde', '--rules', 'r'])).toMatchObject({ rulesDirectory: 'r' });
    expect(parseArgs(['--help'])).toBe('help');
  });

  test('explains what it needs when given too little or too much', () => {
    expect(() => parseArgs([])).toThrow(/Please give a character file and an export template/);
    expect(() => parseArgs(['a.hdc'])).toThrow(HeroError);
    expect(() => parseArgs(['a', 'b', 'c', 'd'])).toThrow(/at most three files/);
    expect(() => parseArgs(['a', 'b', '--rules'])).toThrow(/needs a directory after it/);
    expect(() => parseArgs(['a', 'b', '--wat'])).toThrow(/Unknown option "--wat"/);
  });
});

describe('the render command', () => {
  let expected = '';
  beforeAll(async () => {
    expected = await readFile('fixtures/Redshift.HTML', 'utf8');
  });

  // The whole point of the project, exercised the way a user would.
  test('prints a sheet identical to HERO Designer’s own export', async () => {
    const { code, stdout } = await run([CHARACTER, TEMPLATE]);
    expect(code).toBe(0);
    expect(stdout).toBe(expected);
  });

  test('writes the same bytes to a file when given one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hero-cli-'));
    try {
      const output = join(directory, 'sheet.html');
      const { code } = await run([CHARACTER, TEMPLATE, output]);
      expect(code).toBe(0);
      expect(await readFile(output, 'utf8')).toBe(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Progress goes to stderr so that piping the sheet somewhere stays clean.
  test('keeps its reporting off standard output', async () => {
    const { stdout, stderr } = await run([CHARACTER, TEMPLATE, '-v']);
    expect(stdout).toBe(expected);
    expect(stderr).not.toContain('<html');
  });

  test('prints the usage on request', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: render <character.hdc> <template.hde> [output.html]');
  });

  test.each([
    [[], 2, /Please give a character file/],
    [['a.hdc'], 2, /Please give a character file/],
    [[CHARACTER, TEMPLATE, '--nope'], 2, /Unknown option/],
    [['missing.hdc', TEMPLATE], 1, /Could not read the character file/],
    [[CHARACTER, 'missing.hde'], 1, /Could not read the export template/],
    // An HTML file passed as a character file trips the entity-declaration
    // guard before anything else, which is the right answer for the wrong file.
    [[TEMPLATE, TEMPLATE], 1, /probably not the kind of file it was given as/],
    // Arguments the wrong way round: a character file has no directives in it.
    [[CHARACTER, CHARACTER], 1, /contains no <!--TAGS--> at all/],
  ])('fails cleanly on %p', async (args, code, message) => {
    const result = await run(args as string[]);
    expect(result.code).toBe(code);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).toBe('');
  });

  test('reports an output path it cannot write to', async () => {
    const { code, stderr } = await run([CHARACTER, TEMPLATE, '/nowhere/at/all/sheet.html']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Could not write the character sheet/);
  });
});

describe('the library entry points', () => {
  test('render works from content already in memory', async () => {
    const html = await render(
      await readFile(CHARACTER),
      await readFile(TEMPLATE, 'utf8'),
      {
        characterFileName: 'Redshift.hdc',
        saveTimestamp: new Date(2026, 8, 6, 10, 36, 50),
        logger: silentLogger,
      },
    );
    expect(html).toBe(await readFile('fixtures/Redshift.HTML', 'utf8'));
  });

  // Taking the paths lets the renderer fill in the file's own name, when it was
  // saved, and the build of HERO Designer the rules came from.
  test('renderFiles fills in the details that come from the files', async () => {
    const html = await renderFiles(CHARACTER, TEMPLATE);
    expect(html).toContain('content="Redshift.hdc"');
    expect(html).toContain('content="20260405"');
    // The time is the file's own, rendered in whatever zone this runs in.
    expect(html).toMatch(/content="\w{3}, \d{1,2} \w{3} 2026 \d{2}:\d{2}:\d{2}"/);
  });

  test('renderToFile writes what renderFiles returns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hero-api-'));
    try {
      const output = join(directory, 'sheet.html');
      await renderToFile(CHARACTER, TEMPLATE, output);
      expect(await readFile(output, 'utf8')).toBe(await renderFiles(CHARACTER, TEMPLATE));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('explains a missing file rather than leaking a system error', async () => {
    expect(renderFiles('nope.hdc', TEMPLATE)).rejects.toThrow(HeroError);
    expect(renderFiles('nope.hdc', TEMPLATE)).rejects.toThrow(/Could not read the character file/);
  });
});
