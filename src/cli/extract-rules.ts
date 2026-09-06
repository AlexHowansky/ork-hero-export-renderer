#!/usr/bin/env node
import { isEntryPoint } from '../util/entrypoint.ts';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { HeroError } from '../util/errors.ts';
import { consoleLogger, type Logger } from '../util/logger.ts';
import { ZipArchive } from '../rules/jar.ts';
import { compileTemplate, editionForTemplateId } from '../rules/hdt.ts';
import { resolveSystem } from '../rules/merge.ts';
import {
  RULES_FORMAT_VERSION,
  type ManifestEntry,
  type RuleTemplate,
  type RulesManifest,
} from '../rules/types.ts';

const USAGE = `Usage: extract-rules <HD6.jar> [options]

Compiles the HERO System game rules out of a HERO Designer jar into the JSON
this renderer reads. Run it once, and again whenever you install a new build of
HERO Designer.

Options:
  -o, --out <dir>     Where to write the JSON (default: ./rules)
      --drop-help-text  Omit rule descriptions and examples. These are only used
                        by HERO Designer's own help panes and are most of the
                        bulk, but dropping them is not reversible without a
                        re-run.
  -v, --verbose       Report each file as it is compiled
  -h, --help          Show this message`;

interface Options {
  jarPath: string;
  outDir: string;
  dropHelpText: boolean;
  verbose: boolean;
}

export async function extractRules(options: Options, logger: Logger): Promise<void> {
  const jarBytes = await readJar(options.jarPath);
  const archive = ZipArchive.open(jarBytes, basename(options.jarPath));

  const hdtNames = archive.names.filter((name) => name.endsWith('.hdt') && !name.includes('/')).sort();
  if (hdtNames.length === 0) {
    throw new HeroError(
      'No game system files (*.hdt) were found in this archive. ' +
        'Please point at the HERO Designer program jar, usually named HD6.jar.',
      { source: options.jarPath },
    );
  }
  logger.info(`Found ${hdtNames.length} game system files in ${basename(options.jarPath)}`);

  const templates: RuleTemplate[] = [];
  for (const name of hdtNames) {
    const xml = archive.read(name).toString('utf8');
    const template = compileTemplate(xml, name, { dropHelpText: options.dropHelpText });
    templates.push(template);
    logger.debug(`Compiled ${name} (${countEntries(template)} entries)`);
  }

  // Resolving every chain now turns a corrupt or incomplete jar into an error
  // here, rather than a confusing failure much later during a render.
  const byId = new Map(templates.map((template) => [template.id, template]));
  for (const template of templates) {
    const system = resolveSystem(template.id, byId, logger);
    logger.debug(`Resolved ${template.id} via ${system.chain.join(' -> ')}`);
  }

  await mkdir(options.outDir, { recursive: true });

  const entries: ManifestEntry[] = [];
  for (const template of templates) {
    const path = join(options.outDir, `${template.id}.json`);
    await writeFile(path, `${JSON.stringify(template)}\n`, 'utf8');
    entries.push({
      id: template.id,
      file: template.file,
      edition: editionForTemplateId(template.id),
      ...(template.extends === undefined ? {} : { extends: template.extends }),
      helpTextIncluded: !options.dropHelpText,
    });
    logger.debug(`Wrote ${path}`);
  }

  const manifest: RulesManifest = {
    formatVersion: RULES_FORMAT_VERSION,
    sourceJar: basename(options.jarPath),
    appVersion: formatBuildDate(archive.newestEntryDate),
    extractedAt: new Date().toISOString(),
    templates: entries,
  };
  await writeFile(join(options.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  logger.info(`Wrote ${entries.length} game systems to ${options.outDir}`);
}

async function readJar(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (cause) {
    throw new HeroError(`Could not read the file "${path}". Please check the path and try again.`, { cause });
  }
}

/** HERO Designer names its builds by date, as in "20260405". */
function formatBuildDate(date: Date | undefined): string {
  if (date === undefined) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function countEntries(template: RuleTemplate): number {
  return Object.values(template.sections).reduce((total, section) => total + section.entries.length, 0);
}

export function parseArgs(argv: readonly string[]): Options | 'help' {
  let jarPath: string | undefined;
  let outDir = 'rules';
  let dropHelpText = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '-v':
      case '--verbose':
        verbose = true;
        break;
      case '--drop-help-text':
        dropHelpText = true;
        break;
      case '-o':
      case '--out': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new HeroError(`The ${arg} option needs a directory after it.`);
        }
        outDir = value;
        i++;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          throw new HeroError(`Unknown option "${arg}". Run with --help to see the available options.`);
        }
        if (jarPath !== undefined) {
          throw new HeroError('Please give exactly one jar file to read.');
        }
        jarPath = arg;
    }
  }

  if (jarPath === undefined) {
    throw new HeroError('Please give the path to your HERO Designer jar file, usually named HD6.jar.');
  }
  return { jarPath: resolve(jarPath), outDir: resolve(outDir), dropHelpText, verbose };
}

async function main(): Promise<void> {
  let options: Options | 'help';
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${messageFor(error)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (options === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  try {
    await extractRules(options, consoleLogger(options.verbose ? 'debug' : 'info'));
  } catch (error) {
    process.stderr.write(`${messageFor(error)}\n`);
    process.exitCode = 1;
  }
}

function messageFor(error: unknown): string {
  return error instanceof HeroError || error instanceof Error ? error.message : String(error);
}

if (isEntryPoint(import.meta.url)) {
  await main();
}
