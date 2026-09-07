# HERO Export Renderer

Renders HERO System character sheets by applying a HERO Designer export template
(`*.hde`) to a character file (`*.hdc`), producing the same HTML that HERO
Designer's own export function produces — without needing HERO Designer.

**Status: complete.** Applying `fixtures/Ork-16x9.hde` to `fixtures/Redshift.hdc`,
`fixtures/The Bismarck.hdc` and `fixtures/Azarra.hdc` reproduces
`fixtures/Redshift.HTML`, `fixtures/The Bismarck.HTML` and `fixtures/Azarra.HTML`
— the sheets HERO Designer exported from those same files — **byte for byte**,
with strict mode on, through the command line and through the library alike.

Between them the three characters cover a Multipower and an Elemental Control,
attack, defence, sense and movement powers, charges, foci, linked powers, skill
levels and a vehicle perk, lists of grouped powers and disadvantages, equipment
that can be taken away and so prints two defence figures, an Endurance Reserve,
and skills and talents bought with limitations. Where the arithmetic or the wording was not obvious,
it was taken from HERO Designer's own classes rather than guessed at; what is
still an inference from the fixtures is commented where it lives.

## Rendering a sheet

```sh
render Redshift.hdc Ork-16x9.hde sheet.html   # write a file
render Redshift.hdc Ork-16x9.hde              # or print it
```

Progress goes to standard error, so piping the sheet somewhere stays clean.
`--no-strict` leaves anything the renderer cannot work out blank and carries on,
rather than stopping with an explanation. Directives it does not recognise are
copied through untouched in either mode, which is what HERO Designer does.

```ts
import { renderFiles } from 'ork-hero-export-renderer';

const html = await renderFiles('Redshift.hdc', 'Ork-16x9.hde');
```

The sheet's `CHARACTER_SAVE_TIMESTAMP` is the character file's own modification
time written in **local** time, as HERO Designer writes it, so reproducing a
particular exported sheet means running in the zone it was exported from. Pass
`saveTimestamp` to pin it.

## Game rules data

A character file stores structure, not presentation: a skill is recorded as
`XMLID="ACTING" LEVELS="1" BASECOST="3.0"`, and the text and cost that appear on
the sheet are computed against a *game system* file. HERO Designer ships those
as `*.hdt` files inside its program jar.

Compile them into the JSON this project reads:

```sh
extract-rules /path/to/HD6.jar
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
copyrighted material, so it is not distributed with this package. Extract it
yourself, from your own copy of HERO Designer, with the command above.

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

## Rules calculations

Two conventions run through the engine and explain most of its surprises.

**Totals sum exact costs; only the display rounds.** Redshift's characteristic
costs show as 2, 2 and 16 but contribute 1.5, 1.5 and 16.4, which is why the
sheet totals 168 and not the 169 you get by adding the printed column.

**Fractions stay as `1/2` and `1/4`.** Templates convert them to `½` and `¼`
with their own replacement rules at the end of a render, so producing the
typographic forms early would stop those rules matching.

Figured characteristics are derived from the rules data rather than a
hard-coded table — `Main.hdt` gives STR `PDINCREASE="1" PDINCREASELEVELS="5"`,
so 5 points of STR add 1 to PD's base — which means the sixth-edition tables
fall out of the same code.

## Taking the pipeline apart

`renderFiles` is the four steps below in one call. Every piece is exported, so a
caller can stop partway — to inspect the computed sheet, or to supply different
rules data — without reimplementing any of it.

```ts
import {
  RulesLibrary, parseCharacterFile, parseTemplate,
  renderTemplate, buildSheet, createContext,
} from 'ork-hero-export-renderer';

const library = await RulesLibrary.load();
const character = parseCharacterFile(readFileSync('Redshift.hdc'), 'Redshift.hdc');
const sheet = buildSheet(character, library.system(character.templateId));
const template = parseTemplate(readFileSync('Ork-16x9.hde', 'utf8'));

const html = renderTemplate(template, createContext(sheet, {
  characterFileName: 'Redshift.hdc',
  saveTimestamp: statSync('Redshift.hdc').mtime,
  appVersion: '20260405',
}));
```

The template's own replacement rules run last, over the finished document:

```ts
import { applyReplacements } from 'ork-hero-export-renderer';
const finished = applyReplacements(html, template.replacements);
```

This is what turns `1/2` into `½`, and it is why the rules engine leaves
fractions in their ASCII form until the very end.

Both of these treat the template as input rather than as code. `<!--MATH-->`
expressions are parsed, never evaluated, so a template cannot execute anything;
and replacement patterns are length-capped and refused if they use a Java-only
construct or repeat a group that already repeats.

## Development

```sh
bun install
bun test           # 178 tests, including the byte-for-byte comparison
bun run typecheck
bun run build      # emit dist/ for Node
```

The package targets Bun and runs equally on Node 20 or later. `bun run build`
emits ESM with type declarations; CommonJS is not produced.
