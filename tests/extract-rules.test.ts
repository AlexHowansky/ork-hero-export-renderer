import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ZipArchive } from '../src/rules/jar.ts';
import { compileTemplate } from '../src/rules/hdt.ts';
import { parseXml, type XmlElement } from '../src/xml/parse.ts';
import { RulesLibrary } from '../src/rules/load.ts';
import { extractRules, parseArgs } from '../src/cli/extract-rules.ts';
import { silentLogger } from '../src/util/logger.ts';
import { InvalidFileError } from '../src/util/errors.ts';

// HERO Designer's jar is Hero Games' copyrighted material, so it is not in the
// repository. Point HERO_DESIGNER_JAR at your own install, or drop a copy in
// fixtures/, and the tests that read real rules data will run. Without it they
// skip, and the tests that need no jar still run.
const JAR = process.env['HERO_DESIGNER_JAR'] ?? 'fixtures/HD6.jar';
const noJar = !existsSync(JAR);
const archive = noJar ? null : ZipArchive.open(await readFile(JAR), basename(JAR));

if (noJar) {
  console.warn(
    `Skipping the tests that read real rules data: no HERO Designer jar at "${JAR}". ` +
      'Set HERO_DESIGNER_JAR to the jar from your own copy of HERO Designer to run them.',
  );
}

describe('ZipArchive', () => {
  test.skipIf(noJar)('lists the game system files in the HERO Designer jar', () => {
    const hdt = archive!.names.filter((n) => n.endsWith('.hdt'));
    expect(hdt).toContain('Main.hdt');
    expect(hdt).toContain('Main6E.hdt');
    expect(hdt).toHaveLength(17);
  });

  test.skipIf(noJar)('decompresses an entry to its declared content', () => {
    expect(archive!.read('Superheroic.hdt').toString('utf8')).toStartWith(
      '<TEMPLATE version="2.0" extends="builtIn.Main.hdt">',
    );
  });

  test('explains itself when the file is not an archive', () => {
    expect(() => ZipArchive.open(Buffer.from('not a jar at all'), 'notes.txt')).toThrow(
      /not a readable archive/,
    );
  });

  test.skipIf(noJar)('names the entry that is missing', () => {
    expect(() => archive!.read('Nope.hdt')).toThrow(/does not contain an entry named "Nope.hdt"/);
  });
});

describe('compiling the real rules files', () => {
  /** Every element and attribute in the source XML must survive compilation. */
  function countXml(element: XmlElement): { elements: number; attributes: number } {
    let elements = 1;
    let attributes = Object.keys(element.attributes).length;
    for (const child of element.children) {
      const inner = countXml(child);
      elements += inner.elements;
      attributes += inner.attributes;
    }
    return { elements, attributes };
  }

  test.skipIf(noJar).each(['Main.hdt', 'Main6E.hdt', 'Vehicle.hdt'])(
    '%s compiles without losing data',
    (name) => {
      const xml = archive!.read(name).toString('utf8');
      const source = parseXml(xml, { source: name });
      const template = compileTemplate(xml, name);

      let elements = 1; // the <TEMPLATE> root itself
      let attributes = Object.keys(template.attributes ?? {}).length + (template.extends === undefined ? 0 : 1);
      const walk = (node: { attributes?: object; children?: readonly unknown[] }): void => {
        elements++;
        attributes += Object.keys(node.attributes ?? {}).length;
        for (const child of node.children ?? []) {
          walk(child as never);
        }
      };
      for (const section of Object.values(template.sections)) {
        elements++; // the section element
        attributes += Object.keys(section.attributes ?? {}).length;
        section.entries.forEach(walk);
      }
      // <REMOVE> elements are hoisted out of the entry list into `removals`.
      elements += Object.values(template.removals ?? {}).reduce((n, list) => n + list.length, 0);

      const expected = countXml(source);
      expect({ elements, attributes }).toEqual(expected);
    },
  );
});

describe('extract-rules CLI', () => {
  test('requires a jar path', () => {
    expect(() => parseArgs([])).toThrow(/path to your HERO Designer jar/);
  });

  test('rejects unknown options and extra files', () => {
    expect(() => parseArgs(['a.jar', '--wat'])).toThrow(/Unknown option "--wat"/);
    expect(() => parseArgs(['a.jar', 'b.jar'])).toThrow(/exactly one jar file/);
    expect(() => parseArgs(['a.jar', '--out'])).toThrow(/needs a directory after it/);
  });

  test('recognises help', () => {
    expect(parseArgs(['--help'])).toBe('help');
  });

  test('recognises --version, and does not then demand a jar', () => {
    expect(parseArgs(['--version'])).toBe('version');
    expect(parseArgs(['--version', '--verbose'])).toBe('version');
  });

  test.skipIf(noJar)('writes a manifest and one file per system, which then load and resolve', async () => {
    const out = await mkdtemp(join(tmpdir(), 'hero-rules-'));
    try {
      await extractRules(
        { jarPath: JAR, outDir: out, dropHelpText: false, verbose: false },
        silentLogger,
      );

      const library = await RulesLibrary.load(out);
      expect(library.manifest.sourceJar).toBe(basename(JAR));
      expect(library.systemIds).toHaveLength(17);

      // The fixture character declares TEMPLATE="builtIn.Superheroic.hdt".
      const system = library.system('Superheroic');
      expect(system.chain).toEqual(['Main', 'Superheroic']);
      expect(system.edition).toBe('5e');

      // Exactly the characteristics Redshift.hdc carries: fifth edition, with
      // COM and without OMCV/DMCV.
      expect(system.sections.CHARACTERISTICS.entries.map((e) => e.id)).toEqual([
        'STR', 'DEX', 'CON', 'BODY', 'INT', 'EGO', 'PRE', 'COM', 'PD', 'ED',
        'SPD', 'REC', 'END', 'STUN', 'RUNNING', 'SWIMMING', 'LEAPING',
      ]);

      const maneuvers = system.sections.MARTIAL_ARTS.entries.filter((e) => e.element === 'MANEUVER');
      expect(maneuvers).toHaveLength(53);
      expect(maneuvers.find((m) => m.attributes?.['DISPLAY'] === 'Martial Dodge')?.attributes?.['BASECOST'])
        .toBe('4');

      // Both the MINDSCAN power and <SENSE XMLID="MINDSCAN"> must survive.
      expect(system.sections.POWERS.entries.filter((e) => e.id === 'MINDSCAN')).toHaveLength(2);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('reports a readable error for a file that is not a jar', async () => {
    await expect(
      extractRules(
        { jarPath: 'fixtures/Ork-16x9.hde', outDir: tmpdir(), dropHelpText: false, verbose: false },
        silentLogger,
      ),
    ).rejects.toThrow(InvalidFileError);
  });

  test('reports a readable error for a missing file', async () => {
    await expect(
      extractRules(
        { jarPath: 'fixtures/nope.jar', outDir: tmpdir(), dropHelpText: false, verbose: false },
        silentLogger,
      ),
    ).rejects.toThrow(/Could not read the file/);
  });
});
