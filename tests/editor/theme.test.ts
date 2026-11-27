import { assert, test } from 'orca/testing';

import {
  SEMANTIC_MODIFIERS,
  SEMANTIC_TYPES,
  THEME_NAME,
  themeColors,
  themeRules,
  typographyOptions,
} from '../../editor/src/theme.ts';

test('every semantic token type has a rule in both themes', () => {
  for (const dark of [true, false]) {
    const tokens = new Set(themeRules(dark).map((r) => r.token));
    for (const type of SEMANTIC_TYPES) {
      assert.ok(tokens.has(type), `${type} (${dark ? 'dark' : 'light'})`);
    }
  }
});
test('modifier combinations get exact rules', () => {
  const byToken = new Map(themeRules(true).map((r) => [r.token, r]));
  assert.equal(byToken.get('method.deprecated')?.fontStyle, 'strikethrough');
  assert.equal(byToken.get('method.static.deprecated')?.fontStyle, 'italic strikethrough');
  assert.equal(byToken.get('method.declaration.static')?.fontStyle, 'italic');
  assert.equal(byToken.get('parameter.declaration')?.fontStyle, undefined);
});
test('maps Orca frame variables to editor colours and skips missing ones', () => {
  assert.deepEqual(
    themeColors({ '--orca-background': '#101010', '--orca-foreground': '#eeeeee' }),
    {
      'editor.background': '#101010',
      'editorGutter.background': '#101010',
      'minimap.background': '#101010',
      'editor.foreground': '#eeeeee',
    }
  );
});
test('maps Orca typography to Monaco options', () => {
  assert.deepEqual(
    typographyOptions({
      fontFamily: 'JetBrains Mono',
      cssFontFamily: '"JetBrains Mono", monospace',
      fontSize: 14,
      fontWeight: '400',
      lineHeight: 20,
      fontLigatures: true,
      wordWrap: 'off',
      minimap: false,
    }),
    {
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 14,
      fontWeight: '400',
      lineHeight: 20,
      fontLigatures: true,
      wordWrap: 'off',
      minimap: { enabled: false },
    }
  );
});
test('legend and theme names match PHPantom and Monaco', () => {
  assert.equal(SEMANTIC_TYPES.length, 15);
  assert.deepEqual(
    [...SEMANTIC_MODIFIERS],
    ['declaration', 'static', 'readonly', 'deprecated', 'abstract', 'definition', 'defaultLibrary']
  );
  // One rule per type and per non-empty modifier subset, with modifiers in legend order.
  assert.equal(themeRules(false).length, 15 * 128);
  assert.ok(themeRules(false).some((r) => r.token === 'class.readonly.abstract.defaultLibrary'));
  // Monaco refuses theme names outside [a-z0-9-].
  for (const name of Object.values(THEME_NAME)) assert.match(name, /^[a-z0-9-]+$/);
});
test('colours a type like the base theme colours its nearest token', () => {
  const byToken = new Map(themeRules(true).map((r) => [r.token, r]));
  assert.equal(byToken.get('class')?.foreground, '3DC9B0');
  assert.equal(byToken.get('class.static')?.foreground, '3DC9B0');
  assert.equal(byToken.get('parameter')?.foreground, '74B0DF');
  assert.equal(byToken.get('keyword')?.foreground, '569CD6');
  // The stock themes have no function colour: methods keep the editor's foreground.
  assert.equal(byToken.get('method')?.foreground, undefined);
});
