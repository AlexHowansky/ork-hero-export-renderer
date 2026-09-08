# HERO Export Renderer

Renders HERO System character sheets by applying a HERO Designer export template
(`*.hde`) to a character file (`*.hdc`), producing the same HTML that HERO
Designer's own export function produces — without needing HERO Designer.

**Status: complete.** Applying `fixtures/Ork-16x9.hde` to each of
`fixtures/Redshift.hdc`, `fixtures/The Bismarck.hdc`, `fixtures/Azarra.hdc`,
`fixtures/Porcelain.hdc` and `fixtures/Six.hdc` reproduces the matching
`fixtures/*.HTML` — the sheets HERO Designer exported from those same files —
**byte for byte**, with strict mode on, through the command line and through the
library alike.

Between them the five characters cover both editions, a Multipower and an
Elemental Control, attack, defence, sense, size and movement powers, charges,
foci, linked powers, skill levels bought as skills and as powers, skill
enhancers, a vehicle perk, lists of grouped powers and disadvantages, a suit
that can be taken away and so prints two defence figures, equipment bought with
money and carried at a weight, an Endurance Reserve, powers lent to other
people, and skills and talents bought with limitations. Where the arithmetic or the wording was not obvious,
it was taken from HERO Designer's own classes rather than guessed at; what is
still an inference from the fixtures is commented where it lives.

## Rendering a sheet

First time through, you need the game rules data. It is compiled out of HERO
Designer's own program jar, which is Hero Games' copyright and so is not
distributed here, and it is a one-time step -- see [Game rules
data](#game-rules-data) for the detail:

```sh
npx ork-hero-extract-rules /path/to/HD6.jar   # writes ./rules, once
```

Then:

```sh
npx ork-hero-render Redshift.hdc Ork-16x9.hde sheet.html   # write a file
npx ork-hero-render Redshift.hdc Ork-16x9.hde              # or print it
```

Progress goes to standard error, so piping the sheet somewhere stays clean.
`--no-strict` leaves anything the renderer cannot work out blank and carries on,
rather than stopping with an explanation. Directives it does not recognise are
copied through untouched in either mode, which is what HERO Designer does.

```ts
import { renderFiles } from 'ork-hero-export-renderer';

const html = await renderFiles('Redshift.hdc', 'Ork-16x9.hde');
```

That call reads and parses the whole rules directory each time, which is about
half the cost of a render. Anywhere that renders more than once, load the rules
once and hand them over:

```ts
import { RulesLibrary, renderFiles } from 'ork-hero-export-renderer';

const library = await RulesLibrary.load(rulesDirectory);   // once, at start-up
const html = await renderFiles('Redshift.hdc', 'Ork-16x9.hde', { library });
```

Where the rules are found is described under [Game rules
data](#game-rules-data). Note that the `rules` default is relative to the
process's working directory, not to your module, so an application that does not
start in its own project root should pass an absolute `rulesDirectory` or set
`ORK_HERO_RULES`.

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
npx ork-hero-extract-rules /path/to/HD6.jar
```

`npx` is what reaches the command when this package is a dependency of your
project: npm puts it in `node_modules/.bin`, which is not on your shell's PATH.
The same goes for `ork-hero-render`. Inside your own `package.json` scripts both
names work directly, since npm puts that directory on PATH there. If you would
rather have them as ordinary commands, install globally instead:

```sh
npm install -g ork-hero-export-renderer
ork-hero-extract-rules /path/to/HD6.jar
```

This writes `rules/manifest.json` plus one file per game system. Re-run it after
installing a new build of HERO Designer.

The renderer looks for that data in the `ORK_HERO_RULES` environment variable,
then `./rules`, then the directory alongside the installed package, and takes
the first that has it. `--rules <dir>` overrides all three. Keeping the rules in
your own project rather than inside `node_modules` is deliberate: a reinstall
would wipe them. `--drop-help-text` omits the rule
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
bun test           # 226 tests, including the byte-for-byte comparison
bun run typecheck
bun run build      # emit dist/ for Node
```

The package targets Bun and runs equally on Node 22.12 or later. `bun run build`
emits ESM with type declarations; CommonJS is not produced, though `require()`
reaches the ESM build on Node 22.12+.

### The HERO Designer jar

For the same reason the rules data is not distributed, HERO Designer's program
jar is not in this repository: it is Hero Games' software, not ours to
redistribute. It ships with HERO Designer, as `HD6.jar` in the directory the
installer puts the program in.

Seven tests in `tests/extract-rules.test.ts` compile the real `*.hdt` files and
need it. They look for it at `fixtures/HD6.jar`, or wherever
`HERO_DESIGNER_JAR` points:

```sh
HERO_DESIGNER_JAR=/path/to/HD6.jar bun test
```

Copying or symlinking your own copy into `fixtures/` works too; that path is
gitignored. Without the jar those seven tests skip, with a note saying why, and
the rest of the suite still runs.
