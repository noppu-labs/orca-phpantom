import { readdirSync, readFileSync } from 'node:fs';

import { assert, test } from 'orca/testing';

import {
  COLOUR_SCOPE_CLASS,
  SEMANTIC_MODIFIERS,
  SEMANTIC_TYPES,
  THEME_NAME,
  styleContainer,
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
test("colours the context menu like Orca's own menus", () => {
  const colors = themeColors({
    '--orca-popover': '#202020',
    '--orca-popover-foreground': '#f0f0f0',
    '--orca-accent': '#303030',
    '--orca-accent-foreground': '#ffffff',
    '--orca-border': '#404040',
  });
  assert.equal(colors['menu.background'], '#202020');
  assert.equal(colors['menu.foreground'], '#f0f0f0');
  assert.equal(colors['list.hoverBackground'], '#303030');
  assert.equal(colors['list.hoverForeground'], '#ffffff');
  assert.equal(colors['menu.border'], '#404040');
  assert.equal(colors['menu.separatorBackground'], '#404040');
});
test('styles the container the context menu sits in', () => {
  const classes: string[] = [];
  const properties = new Map<string, string>();
  styleContainer({
    classList: { add: (name: string) => classes.push(name) },
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
  } as unknown as HTMLElement);
  assert.deepEqual(classes, [COLOUR_SCOPE_CLASS]);
  assert.equal(properties.get('--vscode-strokeThickness'), '1px');
});
test("the bundled Monaco still sets its colour variables on the editor container's class", () => {
  // The context menu's shadow host sits in #root, outside .monaco-editor, so it only sees the
  // --vscode-* variables through this rule. A Monaco that renames the selector brings the bug back.
  const dist = new URL('../../editor/dist/', import.meta.url);
  const bundle = readdirSync(dist, { encoding: 'utf8', recursive: true })
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(new URL(file, dist), 'utf8'))
    .join('\n');
  assert.ok(bundle.includes(`.${COLOUR_SCOPE_CLASS} { \${`));
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
  for (const name of Object.values(THEME_NAME)) assert.match(name, /^[a-z0-9-]+$/u);
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
