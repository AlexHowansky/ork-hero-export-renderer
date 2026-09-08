import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RulesError } from '../util/errors.ts';
import { silentLogger, type Logger } from '../util/logger.ts';
import { resolveSystem } from './merge.ts';
import { RULES_FORMAT_VERSION, type RuleSystem, type RuleTemplate, type RulesManifest } from './types.ts';

/** Environment variable holding a rules directory, for CI and containers. */
export const RULES_ENV_VAR = 'ORK_HERO_RULES';

/**
 * Where the package itself sits. Correct when working in this repository, where
 * the checkout root is both the package root and the working directory, but not
 * when installed: that path lands inside `node_modules`, which a reinstall
 * wipes and some setups mount read-only.
 */
function packageRulesDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../rules');
}

/**
 * Every directory the renderer will try, in order, when no explicit one is
 * given. `ork-hero-extract-rules` writes to `./rules` by default, so the
 * working directory has to be on this list or following the instructions in the
 * error below would not actually fix anything.
 */
export function rulesDirectoryCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnvironment = process.env[RULES_ENV_VAR];
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    candidates.push(resolve(fromEnvironment));
  }
  candidates.push(resolve('rules'), packageRulesDirectory());
  // In this repository the last two are the same directory; say it once.
  return [...new Set(candidates)];
}

/**
 * The first candidate that holds extracted rules, or the package's own
 * directory when there are none, so the error names a stable path.
 */
export function defaultRulesDirectory(): string {
  return rulesDirectoryCandidates().find(holdsRules) ?? packageRulesDirectory();
}

function holdsRules(directory: string): boolean {
  return existsSync(join(directory, 'manifest.json'));
}

/**
 * Reads a compiled rules directory and resolves `extends` chains on demand.
 *
 * Chains are applied at load time rather than baked into the files because nine
 * of the seventeen shipped systems extend `Main.hdt`; pre-merging would store
 * that megabyte nine times over.
 */
export class RulesLibrary {
  private readonly resolved = new Map<string, RuleSystem>();

  private constructor(
    readonly manifest: RulesManifest,
    private readonly templates: ReadonlyMap<string, RuleTemplate>,
    private readonly logger: Logger,
  ) {}

  static async load(directory?: string, logger: Logger = silentLogger): Promise<RulesLibrary> {
    // Which places to name in the error: the one asked for, or all we tried.
    const searched = directory === undefined ? rulesDirectoryCandidates() : [resolve(directory)];
    const resolvedDirectory = directory === undefined ? defaultRulesDirectory() : resolve(directory);
    const manifest = await readManifest(resolvedDirectory, searched);
    const templates = new Map<string, RuleTemplate>();
    for (const entry of manifest.templates) {
      const path = join(resolvedDirectory, `${entry.id}.json`);
      const template = JSON.parse(await readFile(path, 'utf8')) as RuleTemplate;
      if (template.formatVersion !== RULES_FORMAT_VERSION) {
        throw new RulesError(
          `The rules file for "${entry.id}" was written in format version ${template.formatVersion}, ` +
            `but this version of the renderer reads version ${RULES_FORMAT_VERSION}. ` +
            'Re-run the rules extraction against your HERO Designer jar.',
          { source: path },
        );
      }
      templates.set(template.id, template);
    }
    return new RulesLibrary(manifest, templates, logger);
  }

  /** Builds a library from templates already in memory. Used by tests. */
  static fromTemplates(
    manifest: RulesManifest,
    templates: Iterable<RuleTemplate>,
    logger: Logger = silentLogger,
  ): RulesLibrary {
    return new RulesLibrary(manifest, new Map([...templates].map((t) => [t.id, t])), logger);
  }

  get systemIds(): string[] {
    return [...this.templates.keys()].sort();
  }

  /** Fully merged rules for one game system. Cached after the first call. */
  system(id: string): RuleSystem {
    const cached = this.resolved.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const system = resolveSystem(id, this.templates, this.logger);
    this.resolved.set(id, system);
    return system;
  }
}

async function readManifest(directory: string, searched: readonly string[]): Promise<RulesManifest> {
  const path = join(directory, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new RulesError(
      'Could not find the game rules data. Looked in:\n' +
        searched.map((candidate) => `  ${candidate}`).join('\n') +
        '\n\nThe rules are compiled from HERO Designer\'s own data files, which are Hero Games\' ' +
        'copyright and so are not distributed with this package. Generate them with:\n' +
        '  npx ork-hero-extract-rules <path to HD6.jar>\n' +
        '(or "ork-hero-extract-rules" on its own, if you installed this globally)\n' +
        `Or point at an existing copy with --rules <dir>, or the ${RULES_ENV_VAR} environment variable.`,
      // No `source`: the message already names every path tried, and appending
      // just one of them reads as though that were the only place we looked.
      { cause },
    );
  }
  const manifest = JSON.parse(raw) as RulesManifest;
  if (manifest.formatVersion !== RULES_FORMAT_VERSION) {
    throw new RulesError(
      `The rules data is in format version ${manifest.formatVersion}, but this version of the renderer ` +
        `reads version ${RULES_FORMAT_VERSION}. Re-run "ork-hero-extract-rules" to regenerate it.`,
      { source: path },
    );
  }
  return manifest;
}
