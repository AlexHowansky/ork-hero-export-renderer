import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { HeroError } from './util/errors.ts';
import { silentLogger, type Logger } from './util/logger.ts';
import { RulesLibrary } from './rules/load.ts';
import { parseCharacterFile } from './hdc/parse.ts';
import { parseTemplate } from './template/parser.ts';
import { hasDirectives } from './template/ast.ts';
import { renderTemplate } from './template/renderer.ts';
import { applyReplacements } from './template/postprocess.ts';
import { buildSheet } from './tags/sheet.ts';
import { createContext } from './tags/context.ts';

/**
 * The whole job in one call: apply an export template to a character file and
 * get back an HTML character sheet.
 */

export interface RenderOptions {
  /**
   * When true (the default), anything the renderer cannot work out stops the
   * render with an explanation. When false it logs and leaves a blank instead.
   *
   * Directives the renderer does not recognise at all are never an error in
   * either mode: they are copied through untouched, as HERO Designer does.
   */
  readonly strict?: boolean;
  readonly logger?: Logger;
  /**
   * Where the compiled rules live. Nothing is shipped with this package: by
   * default the ORK_HERO_RULES environment variable is tried, then `rules` in
   * the working directory, then a directory alongside the package itself.
   *
   * Note that the working directory is the process's, not your module's, so an
   * application whose start-up directory is not its project root should give an
   * absolute path here or set the environment variable.
   */
  readonly rulesDirectory?: string;
  /**
   * Rules already in memory, to render against directly.
   *
   * Every call otherwise reads and parses the whole rules directory, a few
   * megabytes of JSON, which roughly doubles the cost of a render. Somewhere
   * that renders more than once -- a server, a batch job -- should load the
   * library once at start-up and pass it here. Takes precedence over
   * `rulesDirectory`.
   */
  readonly library?: RulesLibrary;
  /** Shown by `<!--CHARACTER_FILE-->`. */
  readonly characterFileName?: string;
  /** Shown by `<!--CHARACTER_SAVE_TIMESTAMP-->`. */
  readonly saveTimestamp?: Date;
  /** Shown by `<!--APP_VERSION-->`. Defaults to the rules data's own build. */
  readonly appVersion?: string;
}

/** Renders from content already in memory. */
export async function render(
  characterFile: Uint8Array | string,
  templateSource: string,
  options: RenderOptions = {},
): Promise<string> {
  const library =
    options.library ?? (await RulesLibrary.load(options.rulesDirectory, options.logger ?? silentLogger));
  const character = parseCharacterFile(characterFile, options.characterFileName);
  const system = library.system(character.templateId);
  const template = parseTemplate(templateSource);
  if (!hasDirectives(template)) {
    const message =
      'This export template contains no <!--TAGS--> at all, so it would produce a page with none ' +
      'of the character in it. Check that the second file is a HERO Designer export template (.hde).';
    if (options.strict !== false) {
      throw new HeroError(message);
    }
    (options.logger ?? silentLogger).warn(message);
  }

  const sheet = buildSheet(character, system, { strict: options.strict !== false });
  const context = createContext(sheet, {
    strict: options.strict !== false,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.characterFileName === undefined ? {} : { characterFileName: options.characterFileName }),
    ...(options.saveTimestamp === undefined ? {} : { saveTimestamp: options.saveTimestamp }),
    appVersion: options.appVersion ?? library.manifest.appVersion,
  });

  // The template's own replacement rules run last, over the finished document.
  return applyReplacements(renderTemplate(template, context), template.replacements, {
    strict: options.strict !== false,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

/**
 * Renders from paths, filling in the details that come from the files
 * themselves: the character file's name and when it was last saved.
 */
export async function renderFiles(
  characterPath: string,
  templatePath: string,
  options: RenderOptions = {},
): Promise<string> {
  const [characterBytes, templateSource, saved] = await Promise.all([
    readFileOrExplain(characterPath, 'character file'),
    readFileOrExplain(templatePath, 'export template').then((bytes) => bytes.toString('utf8')),
    modifiedTime(characterPath),
  ]);

  const saveTimestamp = options.saveTimestamp ?? saved;
  const resolved: RenderOptions = {
    ...options,
    characterFileName: options.characterFileName ?? basename(characterPath),
    ...(saveTimestamp === undefined ? {} : { saveTimestamp }),
  };
  return render(characterBytes, templateSource, resolved);
}

export async function renderToFile(
  characterPath: string,
  templatePath: string,
  outputPath: string,
  options: RenderOptions = {},
): Promise<void> {
  const html = await renderFiles(characterPath, templatePath, options);
  try {
    await writeFile(outputPath, html, 'utf8');
  } catch (cause) {
    throw new HeroError(`Could not write the character sheet to "${outputPath}".`, { cause });
  }
}

async function readFileOrExplain(path: string, description: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (cause) {
    throw new HeroError(`Could not read the ${description} "${path}". Please check the path and try again.`, {
      cause,
    });
  }
}

async function modifiedTime(path: string): Promise<Date | undefined> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return undefined;
  }
}
