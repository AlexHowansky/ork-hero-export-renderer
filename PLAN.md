# HERO Export Renderer — Implementation Plan

## Context

HERO Designer (a closed-source Java desktop app, `fixtures/HD6.jar`) can export a
character (`*.hdc`) to HTML by applying an export template (`*.hde`). That export
step is the only part of the app we need, and it currently requires running a GUI
Java app on Windows. `SPEC.md` asks for a TypeScript library (Bun-first, Node-compatible)
plus a CLI that reproduces it: `render(hdc, hde) -> html`.

Acceptance target: byte-for-byte reproduction of `fixtures/Redshift.HTML` from
`fixtures/Redshift.hdc` + `fixtures/Ork-16x9.hde`.

### What the investigation established

The export engine is `com/hero/util/HTMLWriter.class` in the jar. I extracted its
constant pool, which yields the complete tag vocabulary (~500 directives) and the
call graph into the rules model. Findings that shape the design:

* **Template syntax is uniform and trivial:** every directive is `<!--NAME-->`,
  optionally paired with `<!--/NAME-->`. No attributes, no parameters, no
  alternate delimiters. 393 occurrences / 271 distinct names in `Ork-16x9.hde`.
* **The `.hdc` carries structure, not presentation.** A skill is
  `<SKILL XMLID="ACTING" BASECOST="3.0" LEVELS="1" ALIAS="Acting" CHARACTERISTIC="PRE" .../>`.
  Tags like `SKILL_TEXT`, `POWER_COST`, `STR_ROLL` are *computed* by ~319 classes
  under `com/hero/objects/**` against a game-system rules file.
* **The rules are mostly data.** `Main.hdt` (1.2 MB) and `Main6E.hdt` (945 KB) are
  XML inside the jar holding base costs, level costs, aliases, adders, modifiers,
  and option tables. `Redshift.hdc` declares `TEMPLATE="builtIn.Superheroic.hdt"`,
  which `extends="builtIn.Main.hdt"` — so this fixture is **5th Edition**
  (`Main.hdt`), despite `version="6.0"` (that's the file-format version, not the
  edition). Confirmed by its characteristic set: it has `COM`, lacks `OMCV`/`DMCV`.
  So only calculation and string-formatting logic needs porting, not the data.
* **`.hdc` is UTF-16 *Big* Endian** with a `FE FF` BOM and CRLF, even though the
  XML declaration only says `encoding="UTF-16"`. Decoding as UTF-16LE yields mojibake.
* **Unknown tags pass through verbatim.** `<!--PRIMARY_OMCV-->` and
  `<!--PRIMARY_DMCV-->` survive literally into `Redshift.HTML` because they are not
  in HD's tag table at all. Byte-exactness *requires* reproducing this.
* **False conditionals collapse to empty strings, not deleted lines.**
  `class="text-start <!--IS_LIST-->list<!--/IS_LIST--> <!--IS_LIST_ITEM-->…"` with
  both false renders `class="text-start  "` — two spaces preserved. Loop and
  conditional marker lines become blank lines.

### Decisions taken with the user

1. **Fidelity:** fixture-driven. Implement everything `Redshift.hdc` × `Ork-16x9.hde`
   exercises, gated on a byte-diff against `Redshift.HTML`; extend outward later.
2. **Rules data:** a separate CLI extracts the `*.hdt` files from a HERO Designer jar
   and compiles them to JSON, which is **bundled in the package**. Re-runnable when a
   new HD build ships.
3. **Unimplemented behavior:** strict by default (user-friendly error naming the
   tag/XMLID and template line), `strict: false` downgrades to a logged warning +
   empty string. *Exception:* tags outside HD's known table are not errors — they
   pass through verbatim, per the finding above.

---

## Architecture

```
src/
  index.ts                 # public API: render(), renderToFile(), types
  cli/
    render.ts              # hero-render <char.hdc> <tmpl.hde> [out.html]
    extract-rules.ts       # hero-extract-rules <HD6.jar> [--out rules/]
  template/
    lexer.ts               # source -> [Text | Tag | OpenTag | CloseTag] with line/col
    parser.ts              # -> tree; pairs containers using the known-container set
    renderer.ts            # walks tree against a RenderContext
    postprocess.ts         # REG_REPLACE / REPLACE, applied last, document-wide
  hdc/
    decode.ts              # BOM sniff -> UTF-16BE/LE/UTF-8 -> string
    parse.ts               # XML -> typed Character tree
  rules/
    load.ts                # load bundled JSON, resolve `extends` chain
    types.ts
  model/                   # the rules engine
    character.ts           # assembles Character from hdc + rules
    characteristic.ts      # value/base/cost/roll/secondary, figured characteristics
    ability.ts             # shared: cost, active cost, adders, modifiers, notes
    skill.ts perk.ts talent.ts power.ts disad.ts maneuver.ts equipment.ts
    framework.ts           # Multipower / Elemental Control / VPP slot costing
    format.ts              # dice strings, "12-", fractions, list separators
  tags/
    registry.ts            # TagName -> resolver; also the "is this tag known?" set
    *.ts                   # grouped resolvers (character, characteristics, loops, …)
  util/
    logger.ts errors.ts
rules/                     # generated JSON, committed & shipped
tests/
```

### Public API

```ts
export interface RenderOptions {
  strict?: boolean;              // default true
  logger?: Logger;               // default: silent
  characterFileName?: string;    // for <!--CHARACTER_FILE-->; defaults to basename
  saveTimestamp?: Date;          // defaults to hdc file mtime
  appVersion?: string;           // defaults to the bundled rules' build stamp
}
export function render(hdc: string | Uint8Array, hde: string, o?: RenderOptions): string;
export function renderFiles(hdcPath: string, hdePath: string, o?: RenderOptions): Promise<string>;
export function renderToFile(hdcPath: string, hdePath: string, outPath: string, o?: RenderOptions): Promise<void>;
```

Buffer-in / string-out keeps the library free of `fs` for the core path, so it works
in Bun, Node, and a bundler. Only `renderFiles`/`renderToFile` and the CLIs touch disk.

---

## Implementation phases

Each phase ends with the fixture diff shrinking; that diff is the progress metric.

**Phase 1 — Rules extraction CLI.** Read `*.hdt` entries from a jar with a zip reader,
resolve `<TEMPLATE extends="builtIn.X.hdt">` chains (the merge semantics mirror
`com/hero/Template`: child entries override parent entries by `XMLID` within each of
`MAINAPP CHARACTERISTICS SKILLS SKILL_ENHANCERS MARTIAL_ARTS PERKS TALENTS POWERS
MODIFIERS DISADVANTAGES`), and emit one JSON per system plus a manifest. Ship both the
5e (`Main.hdt`) and 6e (`Main6E.hdt`) chains — `Redshift.hdc` needs 5e.

**Phase 2 — hdc decode + parse.** BOM-sniffing decoder (UTF-16BE is the case that
matters), then XML to a typed tree preserving attribute order-independence, `"Yes"/"No"`
booleans, decimal-string numbers, and CDATA text. `<IMAGE>` base64 stays undecoded until
a tag asks for it.

**Phase 3 — Template lexer/parser/renderer.** Scan for `<!--…-->` where the body matches
`/^\/?[A-Z0-9_]+$/`; anything else (e.g. the file's own banner comment) is literal text.
Pair containers against the known-container set from `HTMLWriter`. Handle metadata
containers (`TEMPLATE_NAME`, `TEMPLATE_DESCRIPTION`, `FILE_EXTENSION`) by splicing them
and their content out — a substring splice, not a line delete, so the trailing `<!--` on
template line 1 survives as output line 1. Collect `REG_REPLACE` blocks for phase 6.

**Phase 4 — Rules engine.** The bulk of the work. Characteristics (base/value/cost/roll,
figured characteristics, primary vs. secondary), then abilities: real cost, active cost,
adder and modifier application, and the display-string builders (`getSkillString`,
`getPowerString`, `getDisadString`, `getModifierString`, `getAdderString` and friends,
which assemble `column1/column2/column3` output). Framework slot costing for the one
`<MULTIPOWER>` in the fixture. Start from exactly what the fixture needs, guided by the
method names recovered from the jar.

**Phase 5 — Tag registry.** ~200 resolvers for the tags `Ork-16x9.hde` uses, plus the
straightforward remainder of the vocabulary. Characteristic containers are generated
from one table over `STR DEX CON BODY INT EGO PRE COM PD ED SPD REC END STUN RUNNING
SWIMMING LEAPING OCV_CHAR DCV_CHAR OMCV DMCV CUSTOM1..10` × suffixes
`_PRIMARY _SECONDARY _BASE _COST _ROLL _NOTES _VAL _TOTAL _ACTIVE_COST …`, mirroring
HD's own reflective dispatch. Loop containers (`SKILLS POWERS DISADS TALENTS MANEUVERS
PERKS EQUIPMENT COMBAT_LEVELS`) push an item scope that the `*_TEXT` / `*_COST` /
`IS_LIST` / `IFNAME` / `IFNOTES` tags read. Implement `START`/`STOP`/`STEP` slicing and
`MATH` (`+ - * / ^` and parentheses, inner tags substituted first) while here.

**Phase 6 — Post-processing.** Apply `REG_REPLACE`/`REPLACE` to the whole document, last.
Java regex → JS regex needs a small translation layer (`\b` and `$1` are compatible; guard
against constructs that aren't, and error clearly rather than silently mis-substituting).

**Phase 7 — CLI + packaging.** `hero-render` with two required args and an optional third,
stdout when omitted. `--strict/--no-strict`, `--verbose`, `--quiet`. Non-zero exit and a
plain-language message on failure. Package with dual ESM/CJS output, `exports` map, and
`types`; `bin` entries for both CLIs.

---

## Security (OWASP)

* **XXE / billion laughs:** the XML parser must have external entity resolution and DTD
  processing disabled outright. `.hdc` files arrive from other people's machines.
* **Zip-slip / zip-bomb** in the rules extractor: reject entry names that escape the
  output root, cap decompressed size and entry count.
* **Path traversal** in the CLI: resolve and validate output paths; never let `.hdc`
  content (`IMAGE/@FilePath`) drive a filesystem read or write.
* **ReDoS:** `REG_REPLACE` patterns come from the template file. Cap pattern length and
  run replacement under a time budget; the CLI's `--allow-template-regex` gate is not
  needed for local use but the timeout is.
* **Output is HTML by design** — templates deliberately inject unescaped character text
  (`CAMPAIGN_USE` becomes raw CSS). Do not "fix" this; document that rendering an
  untrusted `.hdc` produces untrusted HTML, and that consumers must treat the result as
  such rather than embedding it in a trusted origin.
* No network access anywhere in the library.

---

## Verification

* **Golden-file test (the gate):** rendering each character in `fixtures/` with
  `fixtures/Ork-16x9.hde` must equal that character's exported `.HTML` byte for
  byte. Because `CHARACTER_SAVE_TIMESTAMP`
  and `APP_VERSION` are environment-dependent, the test pins them via `RenderOptions`
  (`Sun, 6 Sep 2026 10:36:50` / `20260405`) so the comparison stays deterministic.
  Diff output should be truncated to the first N differing lines to stay readable.
* **Unit tests** per layer: lexer edge cases (the banner comment must stay literal;
  false conditionals must preserve surrounding whitespace; unknown tags must pass
  through), the UTF-16BE decoder, `extends`-chain merging, `MATH` evaluation,
  `REG_REPLACE` ordering, and characteristic/ability cost arithmetic against values
  read off the fixture.
* **CLI smoke test:** run all three arg forms, assert the file-output form and the
  stdout form produce identical bytes, and assert a clear error and non-zero exit for
  a missing file, a non-XML `.hdc`, and an unreadable output path.
* **Manual check:** open the generated HTML in a browser and confirm the tabs, the
  Chart.js panel, and the embedded image render as they do in the fixture.

## Status

All seven phases are implemented. The acceptance gate passes for all five
fixture characters: `Redshift.hdc`, `The Bismarck.hdc`, `Azarra.hdc`,
`Porcelain.hdc` and `Six.hdc` each reproduce their exported sheet byte for byte
in strict mode, verified through the library and the CLI.

The Bismarck settled two of the rules Redshift alone had left to guesswork — how
an Area Of Effect sizes its area, and how an adder priced in the rules data is
costed — and brought the cost model into line with HERO Designer's own: totals,
active costs and real costs each round as they are worked out, with a rounder
that throws away everything past the first decimal before rounding a half down.

Azarra added the parts of a sheet that neither of the others has. Her powers are
grouped under lists (`<LIST XMLID="GENERIC_OBJECT">`), which are headings rather
than abilities and cost nothing. Almost everything she has is in a suit she can
be parted from, so `AFFECTS_PRIMARY` and `AFFECTS_TOTAL` had to become two
separate figures throughout — characteristics, defences and the perception roll
each print `always-on/total` when the two differ. She also brought skills and
talents bought with limitations, a skill bought as a power, an Endurance Reserve
whose store and recovery are limited apart, continuing charges, sense modifiers,
and a disadvantage whose options are listed dearest first.

Porcelain settled how a figured characteristic is put together — each source's
contribution is rounded as it is taken, so her STR 15 and CON 21 give a 39 STUN
base rather than 38, and only SPD and Leaping keep their fractions — and brought
the two powers that describe themselves in the character's own measurements.
Growth and Shrinking read the height and weight from the character file (inches
and pounds) and print metres and kilogrammes, against the per-level figures in
the rules data. She also lends her powers to other people, which puts a combat
skill level among the powers as well as in the combat level table, and adds a
movement power's endurance to what the characteristic itself spends; and she
brought Detect, Mental Defense counting EGO towards its points, Shape Shift,
Desolidification, Telekinesis, Extra Limbs, a familiarity that rolls against the
flat number in the rules, and a Reputation written both as a perk and as a
disadvantage.

Six is the sixth-edition character, and the only one with equipment. Sixth
edition buys OCV, DCV, OMCV and DMCV as characteristics rather than figuring them
from DEX and EGO, so they print as whole numbers, DEX's note is empty, BODY no
longer rolls, and the mental pair is written `ECV 4 - 4`; the edition is told
from the rules data itself, by whether it defines OMCV. It measures the map in
metres rather than inches — the same distances said differently, a point of
endurance covering ten metres where fifth edition covers five inches. Its
equipment is bought with money rather than character points, in the currency,
decimal places and conversion named in the character file's own `<RULES>`
element, and weighed in kilogrammes; the quantity column divides one money figure
by another, so `<!--MATH-->` ignores anything that is not part of a number. Six
also brought skill enhancers, which head a group of skills the way a framework
heads its slots and, unlike a familiarity, do not roll at all — HERO Designer
leaves `<!--SKILL_ROLL-->` itself in the sheet.

Six buys every characteristic a second time as a power that is not always on,
which settled how the sheet writes a figure it has two of. Any characteristic
bought as a power raises that characteristic — not just the movement ones —
which puts a second figure in the Value column and, with it, a second roll
(`11- / 12-`), a second PRE Attack (`2d6 / 3d6`), a second set of Phases and a
second HTH damage and endurance (`HTH Damage 2d6/3d6  END [1/2]`, which the
template's own fraction replacement then writes as `END [½]`). The separators
are HERO Designer's and are not consistent; a skill inherits the pair from the
characteristic it rolls against and brackets it instead (`11- (12-)`); a defence
prints the pair only when the defence itself changes, and then writes its
resistant half as one figure when that does not; and a movement power adds its
endurance to the figure it belongs to rather than to both.

It also settled two rounding questions. A characteristic's cost column never
rounds away something that was paid for — one END costs a fifth of a point in
sixth edition and the sheet writes 1 — and the power column, which rounds each
cost up, is totalled from the exact costs rather than the printed ones: a
part-block of levels costs the fraction it is, so two powers that each cost 2 1/2
print 3 and add up to 5.

What is still inferred from the fixtures, and commented where it lives:

* the two-space separator before a subject, which Knowledge Skills alone do not use;
* the reading of `ADDERSEPARATOR` on a disadvantage;
* which modifiers open their bracket at the option, print it after their name, or
  do not print it at all — a per-modifier decision HERO Designer makes in code
  rather than in its rules data.

## Open items to settle during implementation

* Package name and whether the two CLIs ship as one `bin` with subcommands or two.
* Whether the generated `rules/*.json` is committed (reproducible builds, no jar needed
  to install) or generated at prepublish. Committing is the recommendation.
* The bundled rules data is derived from Hero Games' proprietary `.hdt` files. Worth a
  note in the README about the provenance before publishing anywhere public.
