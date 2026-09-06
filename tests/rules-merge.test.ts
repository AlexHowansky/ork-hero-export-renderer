import { describe, expect, test } from 'bun:test';
import { compileTemplate, editionForTemplateId, templateIdFromReference } from '../src/rules/hdt.ts';
import { indexSection, resolveSystem } from '../src/rules/merge.ts';
import type { RuleTemplate } from '../src/rules/types.ts';

function compile(file: string, body: string): RuleTemplate {
  return compileTemplate(`<TEMPLATE version="2.0"${body}`, file);
}

const PARENT = compile(
  'Parent.hdt',
  `>
    <MAINAPP HEIGHT="Yes" NCM_COST_MULTIPLIER="2">
      <NAME1>Character Name</NAME1>
      <NCM XMLID="NCM" BASECOST="0"/>
    </MAINAPP>
    <CHARACTERISTICS>
      <STR DISPLAY="STR" BASE="10" LVLCOST="1"/>
      <EGO DISPLAY="EGO" BASE="10" LVLCOST="1"/>
    </CHARACTERISTICS>
    <SKILLS><SKILL XMLID="ACTING" DISPLAY="Acting"/></SKILLS>
    <SKILL_ENHANCERS/><MARTIAL_ARTS/><PERKS/><TALENTS/><POWERS/><MODIFIERS/><DISADVANTAGES/>
  </TEMPLATE>`,
);

describe('template compilation', () => {
  test('keys entries by XMLID when present and by tag name otherwise', () => {
    expect(PARENT.sections.CHARACTERISTICS?.entries.map((e) => e.id)).toEqual(['STR', 'EGO']);
    expect(PARENT.sections.SKILLS?.entries.map((e) => e.id)).toEqual(['ACTING']);
  });

  test('collects REMOVE directives per section instead of storing them as entries', () => {
    const child = compile(
      'Child.hdt',
      ` extends="builtIn.Parent.hdt">
        <CHARACTERISTICS><REMOVE>STR</REMOVE></CHARACTERISTICS>
      </TEMPLATE>`,
    );
    expect(child.extends).toBe('Parent');
    expect(child.removals?.CHARACTERISTICS).toEqual(['STR']);
    expect(child.sections.CHARACTERISTICS?.entries).toEqual([]);
  });

  test('rejects a file whose sections are not HERO sections', () => {
    expect(() => compile('Bad.hdt', '><NONSENSE/></TEMPLATE>')).toThrow(/unexpected section <NONSENSE>/);
  });

  test('rejects a file that is not a template at all', () => {
    expect(() => compileTemplate('<CHARACTER/>', 'Wrong.hdt')).toThrow(/does not look like/);
  });

  test('reads references in every form HERO writes them', () => {
    expect(templateIdFromReference('builtIn.Superheroic.hdt')).toBe('Superheroic');
    expect(templateIdFromReference('C:\\HD\\Custom\\House Rules.hdt')).toBe('House Rules');
  });

  test('identifies the edition from the template id', () => {
    expect(editionForTemplateId('Main6E')).toBe('6e');
    expect(editionForTemplateId('Superheroic')).toBe('5e');
  });
});

describe('resolveSystem', () => {
  const resolve = (...templates: RuleTemplate[]) =>
    resolveSystem(
      templates[templates.length - 1]!.id,
      new Map([PARENT, ...templates].map((t) => [t.id, t])),
    );

  test('merges entry attributes rather than replacing the entry', () => {
    const child = compile(
      'Child.hdt',
      ` extends="builtIn.Parent.hdt">
        <CHARACTERISTICS><EGO BASE="0" LVLCOST="2" ECVINCREASE="1"/></CHARACTERISTICS>
      </TEMPLATE>`,
    );
    const ego = resolve(child).sections.CHARACTERISTICS.entries.find((e) => e.id === 'EGO');
    // BASE and LVLCOST come from the child, DISPLAY is inherited.
    expect(ego?.attributes).toEqual({ DISPLAY: 'EGO', BASE: '0', LVLCOST: '2', ECVINCREASE: '1' });
  });

  test('lets child children replace parent children outright', () => {
    const child = compile(
      'Child.hdt',
      ` extends="builtIn.Parent.hdt">
        <SKILLS><SKILL XMLID="ACTING"><OPTION XMLID="ONE"/></SKILL></SKILLS>
      </TEMPLATE>`,
    );
    const acting = resolve(child).sections.SKILLS.entries.find((e) => e.id === 'ACTING');
    expect(acting?.children?.map((c) => c.id)).toEqual(['ONE']);
  });

  test('merges section attributes key by key', () => {
    const child = compile(
      'Child.hdt',
      ` extends="builtIn.Parent.hdt">
        <MAINAPP HEIGHT="No"/>
      </TEMPLATE>`,
    );
    // HEIGHT is overridden; NCM_COST_MULTIPLIER, which the child never mentions, survives.
    expect(resolve(child).sections.MAINAPP.attributes).toEqual({
      HEIGHT: 'No',
      NCM_COST_MULTIPLIER: '2',
    });
  });

  test('applies REMOVE, and preserves order for what is left', () => {
    const child = compile(
      'Child.hdt',
      ` extends="builtIn.Parent.hdt">
        <CHARACTERISTICS><REMOVE>STR</REMOVE></CHARACTERISTICS>
      </TEMPLATE>`,
    );
    expect(resolve(child).sections.CHARACTERISTICS.entries.map((e) => e.id)).toEqual(['EGO']);
  });

  test('appends entries the parent does not have', () => {
    const child = compile(
      'Child.hdt',
      ` extends="builtIn.Parent.hdt">
        <SKILLS><SKILL XMLID="BREAKFALL"/></SKILLS>
      </TEMPLATE>`,
    );
    expect(resolve(child).sections.SKILLS.entries.map((e) => e.id)).toEqual(['ACTING', 'BREAKFALL']);
  });

  // HERO Designer's own 6E systems still remove NCM, which Main6E.hdt no longer
  // defines. It ignores that, so a stale removal must not be an error.
  test('ignores a removal whose target does not exist', () => {
    const child = compile(
      'Child.hdt',
      ` extends="builtIn.Parent.hdt">
        <CHARACTERISTICS><REMOVE>NOT_THERE</REMOVE></CHARACTERISTICS>
      </TEMPLATE>`,
    );
    expect(() => resolve(child)).not.toThrow();
  });

  // All martial maneuvers share XMLID="MANEUVER"; collapsing them by id would
  // leave one of fifty-three.
  test('keeps entries that share an id within one file', () => {
    const many = compile(
      'Many.hdt',
      ` extends="builtIn.Parent.hdt">
        <MARTIAL_ARTS>
          <MANEUVER DISPLAY="Basic Strike" BASECOST="4"/>
          <MANEUVER DISPLAY="Charge" BASECOST="4"/>
          <MANEUVER DISPLAY="Choke Hold" BASECOST="4"/>
        </MARTIAL_ARTS>
      </TEMPLATE>`,
    );
    const maneuvers = resolve(many).sections.MARTIAL_ARTS.entries;
    expect(maneuvers).toHaveLength(3);
    expect(maneuvers.map((m) => m.attributes?.['DISPLAY'])).toEqual(['Basic Strike', 'Charge', 'Choke Hold']);
  });

  // POWERS holds both a MINDSCAN power and a <SENSE XMLID="MINDSCAN">.
  test('keeps same-id entries that are different kinds of element', () => {
    const both = compile(
      'Both.hdt',
      ` extends="builtIn.Parent.hdt">
        <POWERS><MINDSCAN BASECOST="0"/><SENSE XMLID="MINDSCAN" DISPLAY="Mind Scan"/></POWERS>
      </TEMPLATE>`,
    );
    expect(resolve(both).sections.POWERS.entries.map((e) => e.element)).toEqual(['MINDSCAN', 'SENSE']);
  });

  test('reports an unknown system by name', () => {
    expect(() => resolveSystem('Nope', new Map([[PARENT.id, PARENT]]))).toThrow(/Unknown game system "Nope"/);
  });

  test('reports a missing parent as a rules-data problem', () => {
    const orphan = compile('Orphan.hdt', ' extends="builtIn.Gone.hdt"></TEMPLATE>');
    expect(() => resolveSystem('Orphan', new Map([['Orphan', orphan]]))).toThrow(/missing from the rules data/);
  });

  test('detects a cycle instead of looping forever', () => {
    const a = compile('A.hdt', ' extends="builtIn.B.hdt"></TEMPLATE>');
    const b = compile('B.hdt', ' extends="builtIn.A.hdt"></TEMPLATE>');
    expect(() =>
      resolveSystem('A', new Map([
        ['A', a],
        ['B', b],
      ])),
    ).toThrow(/extends itself/);
  });
});

describe('indexSection', () => {
  test('groups entries that share an id', () => {
    const index = indexSection({
      entries: [
        { element: 'MANEUVER', id: 'MANEUVER' },
        { element: 'MANEUVER', id: 'MANEUVER' },
        { element: 'SKILL', id: 'ACTING' },
      ],
    });
    expect(index.get('MANEUVER')).toHaveLength(2);
    expect(index.get('ACTING')).toHaveLength(1);
  });
});
