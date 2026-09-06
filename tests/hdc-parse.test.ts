import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { groupByFramework, isYes, parseCharacterFile } from '../src/hdc/parse.ts';
import { InvalidFileError } from '../src/util/errors.ts';

const character = parseCharacterFile(readFileSync('fixtures/Redshift.hdc'), 'Redshift.hdc');
const html = readFileSync('fixtures/Redshift.HTML', 'utf8');

describe('the fixture character', () => {
  test('reads the header and the game system it points at', () => {
    expect(character.version).toBe('6.0');
    // version="6.0" is the file format, not the rules edition: this character
    // is fifth edition, which is why it has COM and no OMCV.
    expect(character.templateId).toBe('Superheroic');
    expect(character.characteristics.map((c) => c.xmlId)).toContain('COM');
    expect(character.characteristics.map((c) => c.xmlId)).not.toContain('OMCV');
  });

  test('reads the point configuration', () => {
    expect(character.configuration).toEqual({
      basePoints: 250,
      disadPoints: 150,
      experience: 25,
      exportTemplate:
        'C:\\Program Files\\HERODesigner 6 Build 20260405\\Custom Export Formats\\Ork-16x9.hde',
      rules: 'Default',
    });
  });

  test('reads identity fields, including escaped quotes', () => {
    expect(character.info.characterName).toBe('Redshift');
    expect(character.info.alternateIdentities).toBe('Elias "Eli" Mercer');
  });

  test('reads multi-line prose with line endings normalized', () => {
    expect(character.info.background).toHaveLength(749);
    expect(character.info.background).not.toContain('\r');
    expect(character.info.campaignUse).toStartWith("@import url('https://fonts.cdnfonts.com/css/");
    expect(character.info.campaignUse).not.toContain('\r');
  });

  test('finds every section', () => {
    expect(character.characteristics).toHaveLength(17);
    expect(character.skills).toHaveLength(29);
    expect(character.talents).toHaveLength(2);
    expect(character.martialArts).toHaveLength(3);
    expect(character.powers).toHaveLength(9);
    expect(character.disadvantages).toHaveLength(13);
    // Empty sections are present but empty, which is why the sheet omits them.
    expect(character.perks).toEqual([]);
    expect(character.equipment).toEqual([]);
  });

  test('reads an ability’s structural fields and keeps every attribute', () => {
    const acting = character.skills.find((s) => s.xmlId === 'ACTING');
    expect(acting).toMatchObject({
      element: 'SKILL',
      xmlId: 'ACTING',
      alias: 'Acting',
      name: '',
      levels: 1,
      baseCost: 3,
      position: 0,
    });
    expect(acting?.attributes['CHARACTERISTIC']).toBe('PRE');
    expect(isYes(acting?.attributes['FAMILIARITY'])).toBe(false);
  });

  test('sorts nested elements into notes, adders and modifiers', () => {
    const power = character.powers.find((p) => p.xmlId === 'CHANGEENVIRONMENT');
    expect(power?.adders.map((a) => a.xmlId)).toEqual(['OCVDCV']);
    expect(power?.modifiers.map((m) => m.xmlId)).toEqual([
      'SELECTIVETARGET',
      'BOECV',
      'REDUCEDEND',
      'AFFECTSDESOLID',
    ]);
    expect(power?.children).toEqual([]);
  });

  test('keeps entries that share an XMLID', () => {
    // Two separate Stretching slots, told apart only by their ID.
    const stretching = character.powers.filter((p) => p.xmlId === 'STRETCHING');
    expect(stretching).toHaveLength(2);
    expect(stretching[0]?.id).not.toBe(stretching[1]?.id);
  });

  test('reads the character portrait, matching the exported sheet byte for byte', () => {
    expect(character.image?.fileName).toBe('redshift small.png');
    const hex = Buffer.from(character.image?.base64 ?? '', 'base64').toString('hex');
    expect(hex).toStartWith('89504e470d0a1a0a'); // PNG signature
    expect(html).toContain(`const imageHex = '${hex}'`);
  });
});

describe('groupByFramework', () => {
  test('links slots to their Multipower, which is a sibling not a parent', () => {
    const { standalone, slotsByFrameworkId } = groupByFramework(character.powers);
    const multipower = character.powers.find((p) => p.element === 'MULTIPOWER');
    expect(standalone).toHaveLength(4);
    expect(slotsByFrameworkId.get(multipower?.id ?? '')).toHaveLength(5);
  });

  test('keeps an entry whose parent is not in the section', () => {
    const orphan = { ...character.powers[0]!, parentId: 'nowhere' };
    const { standalone, slotsByFrameworkId } = groupByFramework([orphan]);
    expect(standalone).toEqual([orphan]);
    expect(slotsByFrameworkId.size).toBe(0);
  });
});

describe('rejecting files that are not characters', () => {
  test('names the element it found instead', () => {
    expect(() => parseCharacterFile('<TEMPLATE version="2.0"/>', 'Main.hdt')).toThrow(
      /found <TEMPLATE>.*does not look like/s,
    );
  });

  test('requires a game system reference', () => {
    expect(() => parseCharacterFile('<CHARACTER version="6.0"/>')).toThrow(
      /does not say which game system/,
    );
  });

  test('refuses entity declarations in a character file', () => {
    const xxe = '<!DOCTYPE c [<!ENTITY x SYSTEM "file:///etc/passwd">]><CHARACTER TEMPLATE="a.hdt"/>';
    expect(() => parseCharacterFile(xxe, 'evil.hdc')).toThrow(InvalidFileError);
  });

  test('copes with a character that has no sections at all', () => {
    const bare = parseCharacterFile('<CHARACTER version="6.0" TEMPLATE="builtIn.Heroic.hdt"/>');
    expect(bare.templateId).toBe('Heroic');
    expect(bare.skills).toEqual([]);
    expect(bare.info.characterName).toBe('');
    expect(bare.info.notes).toEqual(['', '', '', '', '']);
    expect(bare.image).toBeUndefined();
  });
});
