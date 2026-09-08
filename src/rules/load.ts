import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RulesError } from '../util/errors.ts';
import { silentLogger, type Logger } from '../util/logger.ts';
import { resolveSystem } from './merge.ts';
import { RULES_FORMAT_VERSION, type RuleSystem, type RuleTemplate, type RulesManifest } from './types.ts';

/**
 * Default location of the extracted data, relative to this file. The rules are
 * not shipped with the package; `ork-hero-extract-rules` writes them here.
 */
export function defaultRulesDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../rules');
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

  static async load(
    directory: string = defaultRulesDirectory(),
    logger: Logger = silentLogger,
  ): Promise<RulesLibrary> {
    const manifest = await readManifest(directory);
    const templates = new Map<string, RuleTemplate>();
    for (const entry of manifest.templates) {
      const path = join(directory, `${entry.id}.json`);
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

async function readManifest(directory: string): Promise<RulesManifest> {
  const path = join(directory, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new RulesError(
      `Could not read the game rules data at ${path}. ` +
        'Run "ork-hero-extract-rules <path to HD6.jar>" to generate it.',
      { source: path, cause },
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
