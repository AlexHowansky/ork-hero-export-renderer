# HERO Export Renderer

Renders HERO System character sheets by applying a HERO Designer export template
(`*.hde`) to a character file (`*.hdc`), producing the same HTML that HERO
Designer's own export function produces — without needing HERO Designer.

**Status: in progress.** Phases 1–3 are complete: the game-rules layer, reading
character files, and the template engine. The rules calculations, the tag
vocabulary and the rendering CLI are still to come. See `PLAN.md`.

## Game rules data

A character file stores structure, not presentation: a skill is recorded as
`XMLID="ACTING" LEVELS="1" BASECOST="3.0"`, and the text and cost that appear on
the sheet are computed against a *game system* file. HERO Designer ships those
as `*.hdt` files inside its program jar.

Compile them into the JSON this project reads:

```sh
bun run src/cli/extract-rules.ts /path/to/HD6.jar
```

This writes `rules/manifest.json` plus one file per game system. Re-run it after
installing a new build of HERO Designer. `--drop-help-text` omits the rule
descriptions and examples, which only HERO Designer's own help panes use; it
saves about 13% and is rarely worth it.

Chains are stored unresolved and merged at load time, because nine of the
seventeen systems extend `Main.hdt` and pre-merging would store it nine times.

```ts
import { RulesLibrary } from 'ork-hero-export-renderer';

const library = await RulesLibrary.load();
const system = library.system('Superheroic'); // chain: Main -> Superheroic
```

The rules data is derived from Hero Games' `*.hdt` files and is their
copyrighted material. It is included here for use with characters you built in
your own copy of HERO Designer.

## Reading a character file

```ts
import { parseCharacterFile } from 'ork-hero-export-renderer';
import { readFileSync } from 'node:fs';

const character = parseCharacterFile(readFileSync('Redshift.hdc'), 'Redshift.hdc');
character.info.characterName; // "Redshift"
character.templateId;         // "Superheroic" — which game system to load
```

Two details of the format are worth knowing, because getting either wrong is
silent rather than loud:

* `.hdc` files are UTF-16 **big** endian with a byte-order mark, even though the
  XML declaration inside says only `encoding="UTF-16"`. The mark is the
  authority; the declaration is not.
* Prose fields store line breaks as CRLF, but HERO Designer's exports contain no
  carriage returns. XML line-ending normalization is applied on read, as the
  spec requires, so what you get back matches what an export contains.

## Export templates

An export template is HTML with directives written as comments. There is one
syntax and no other: `<!--NAME-->` is a tag, and `<!--NAME-->` … `<!--/NAME-->`
is a container whose body is conditional, repeated, or transformed.

```ts
import { parseTemplate, renderTemplate } from 'ork-hero-export-renderer';

const template = parseTemplate(readFileSync('Ork-16x9.hde', 'utf8'));
const html = renderTemplate(template, context);
```

Three behaviours the engine copies deliberately, because an exported sheet
depends on each:

* **Unknown directives pass through verbatim.** HERO Designer's own exports
  contain `<!--PRIMARY_OMCV-->` because that name is not in its tag table.
* **Whether a name is a container is decided by the template**, not by a fixed
  list — a name that is never closed is a tag. The vocabulary is partly
  generated (`STR_VAL`, `RUNNING_PRIMARY`), so no list could be complete.
* **A false conditional collapses in place**, leaving the whitespace around it,
  which is why exported sheets contain `class="text-start  "` with two spaces.

## Development

```sh
bun install
bun test
bun run typecheck
```
