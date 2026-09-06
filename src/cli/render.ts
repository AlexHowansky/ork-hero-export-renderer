#!/usr/bin/env node
import { isEntryPoint } from '../util/entrypoint.ts';
import { HeroError } from '../util/errors.ts';
import { consoleLogger, type LogLevel } from '../util/logger.ts';
import { renderFiles, renderToFile } from '../render.ts';

const USAGE = `Usage: render <character.hdc> <template.hde> [output.html]

Applies a HERO Designer export template to a character file and writes the
resulting character sheet. With no output file, the sheet goes to standard
output.

Options:
      --rules <dir>   Where the compiled game rules live (default: bundled)
      --no-strict     Leave anything that cannot be worked out blank, and carry
                      on, instead of stopping with an explanation
  -v, --verbose       Report progress on standard error
  -q, --quiet         Report nothing but failures
  -h, --help          Show this message

Directives the renderer does not recognise are copied through untouched in
either mode, which is what HERO Designer itself does.`;

export interface Options {
  characterPath: string;
  templatePath: string;
  outputPath: string | undefined;
  rulesDirectory: string | undefined;
  strict: boolean;
  logLevel: LogLevel;
}

export function parseArgs(argv: readonly string[]): Options | 'help' {
  const positional: string[] = [];
  let rulesDirectory: string | undefined;
  let strict = true;
  let logLevel: LogLevel = 'warn';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '-v':
      case '--verbose':
        logLevel = 'debug';
        break;
      case '-q':
      case '--quiet':
        logLevel = 'error';
        break;
      case '--strict':
        strict = true;
        break;
      case '--no-strict':
        strict = false;
        break;
      case '--rules': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new HeroError('The --rules option needs a directory after it.');
        }
        rulesDirectory = value;
        i++;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          throw new HeroError(`Unknown option "${arg}". Run with --help to see the available options.`);
        }
        positional.push(arg);
    }
  }

  const [characterPath, templatePath, outputPath, ...extra] = positional;
  if (characterPath === undefined || templatePath === undefined) {
    throw new HeroError(
      'Please give a character file and an export template, for example: ' +
        'render Redshift.hdc Ork-16x9.hde',
    );
  }
  if (extra.length > 0) {
    throw new HeroError(
      `Expected at most three files, but got ${positional.length}. ` +
        'The third is where to write the sheet; leave it out to print it instead.',
    );
  }
  return { characterPath, templatePath, outputPath, rulesDirectory, strict, logLevel };
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

  const logger = consoleLogger(options.logLevel);
  const settings = {
    strict: options.strict,
    logger,
    ...(options.rulesDirectory === undefined ? {} : { rulesDirectory: options.rulesDirectory }),
  };

  try {
    if (options.outputPath === undefined) {
      // Straight to standard output, which is why the logger writes to stderr.
      process.stdout.write(await renderFiles(options.characterPath, options.templatePath, settings));
    } else {
      await renderToFile(options.characterPath, options.templatePath, options.outputPath, settings);
      logger.info(`Wrote ${options.outputPath}`);
    }
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
