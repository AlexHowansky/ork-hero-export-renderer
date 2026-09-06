# HERO Export Renderer

Renders HERO System character sheets by applying a HERO Designer export template
(`*.hde`) to a character file (`*.hdc`), producing the same HTML that HERO
Designer's own export function produces — without needing HERO Designer.

**Status: in progress.** Phase 1, the game-rules layer, is complete. The
template engine, the rules calculations and the rendering CLI are still to come.
See `PLAN.md`.

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
import { RulesLibrary } from 'hero-export-renderer';

const library = await RulesLibrary.load();
const system = library.system('Superheroic'); // chain: Main -> Superheroic
```

The rules data is derived from Hero Games' `*.hdt` files and is their
copyrighted material. It is included here for use with characters you built in
your own copy of HERO Designer.

## Development

```sh
bun install
bun test
bun run typecheck
```
