// The editor's two themes: Monaco's stock dark and light token colours, a rule for every semantic token
// PHPantom sends, and editor chrome in Orca's colours. Monaco comes in as a parameter, so Node can test it.
import type { HostResult } from 'orca/host';

/** What `editor.readTypography` answers and `editor.typography.changed` carries. */
export type EditorTypography = HostResult<'editor.readTypography'>;

/** PHPantom's semantic token legend, in its order. */
export const SEMANTIC_TYPES: readonly string[] = [
  'namespace',
  'class',
  'interface',
  'enum',
  'type',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'function',
  'method',
  'decorator',
  'enumMember',
  'keyword',
  'comment',
];
export const SEMANTIC_MODIFIERS: readonly string[] = [
  'declaration',
  'static',
  'readonly',
  'deprecated',
  'abstract',
  'definition',
  'defaultLibrary',
];

export const THEME_NAME = { dark: 'phpantom-dark', light: 'phpantom-light' } as const;

type Base = 'variable' | 'type' | 'keyword' | 'comment' | 'annotation';

// Monaco's own `vs-dark` and `vs` rules (editor/standalone/common/themes.js). Neither has a function
// colour, so functions and methods keep the editor's foreground, as they do without semantic tokens.
const BASE_COLOURS: Record<'dark' | 'light', Record<Base, string>> = {
  dark: {
    variable: '74B0DF',
    type: '3DC9B0',
    keyword: '569CD6',
    comment: '608B4E',
    annotation: 'cc6666',
  },
  light: {
    variable: '001188',
    type: '008080',
    keyword: '0000FF',
    comment: '008000',
    annotation: '808080',
  },
};

const NEAREST: Record<string, Base | null> = {
  namespace: 'type',
  class: 'type',
  interface: 'type',
  enum: 'type',
  type: 'type',
  typeParameter: 'type',
  parameter: 'variable',
  variable: 'variable',
  property: 'variable',
  enumMember: 'variable',
  function: null,
  method: null,
  decorator: 'annotation',
  keyword: 'keyword',
  comment: 'comment',
};

export type ThemeRule = { token: string; foreground?: string; fontStyle?: string };

/**
 * Monaco styles a semantic token by the rule matching `type.mod1.mod2…` (modifiers in legend order)
 * or its longest dot-prefix, with no wildcards. So every type gets a rule for each non-empty subset of
 * the modifiers: static ones are italic and deprecated ones struck through, whatever else they carry.
 */
export function themeRules(dark: boolean): ThemeRule[] {
  const colours = BASE_COLOURS[dark ? 'dark' : 'light'];
  const rules: ThemeRule[] = [];
  for (const type of SEMANTIC_TYPES) {
    const nearest = NEAREST[type];
    const colour = nearest ? { foreground: colours[nearest] } : {};
    rules.push({ token: type, ...colour });
    for (let mask = 1; mask < 1 << SEMANTIC_MODIFIERS.length; mask++) {
      const modifiers = SEMANTIC_MODIFIERS.filter((_, index) => mask & (1 << index));
      const styles = [
        modifiers.includes('static') && 'italic',
        modifiers.includes('deprecated') && 'strikethrough',
      ].filter(Boolean);
      rules.push({
        token: [type, ...modifiers].join('.'),
        ...colour,
        ...(styles.length > 0 ? { fontStyle: styles.join(' ') } : {}),
      });
    }
  }
  return rules;
}

/** Orca's frame variables and the Monaco colours each one sets. */
const FRAME_COLOURS: [string, string[]][] = [
  ['--orca-background', ['editor.background', 'editorGutter.background', 'minimap.background']],
  ['--orca-foreground', ['editor.foreground']],
  [
    '--orca-popover',
    ['editorWidget.background', 'editorHoverWidget.background', 'editorSuggestWidget.background'],
  ],
  [
    '--orca-popover-foreground',
    ['editorWidget.foreground', 'editorHoverWidget.foreground', 'editorSuggestWidget.foreground'],
  ],
  [
    '--orca-border',
    ['editorWidget.border', 'editorHoverWidget.border', 'editorSuggestWidget.border'],
  ],
  ['--orca-ring', ['focusBorder']],
  ['--orca-muted-foreground', ['editorLineNumber.foreground']],
];

/** Editor chrome from Orca's frame variables (already `#rrggbb`); a missing one keeps the base colour. */
export function themeColors(vars: Record<string, string>): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [variable, keys] of FRAME_COLOURS) {
    const value = vars[variable];
    if (value) {
      for (const key of keys) colors[key] = value;
    }
  }
  return colors;
}

/** Orca's file editor typography as Monaco options. */
export function typographyOptions(t: EditorTypography) {
  return {
    fontFamily: t.cssFontFamily,
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    lineHeight: t.lineHeight,
    fontLigatures: t.fontLigatures,
    wordWrap: t.wordWrap,
    minimap: { enabled: t.minimap },
  };
}

/**
 * Reads Orca's frame variables as `#rrggbb`, whatever CSS colour syntax they use, by painting each on
 * a 1×1 canvas. A translucent colour is painted over the background first, as the page shows it.
 */
export function readOrcaVars(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return {};
  }
  const paint = (colours: string[]): string => {
    context.clearRect(0, 0, 1, 1);
    for (const colour of colours) {
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
    }
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  };
  const valid = (value: string): boolean => value !== '' && CSS.supports('color', value);
  const background = style.getPropertyValue('--orca-background').trim();
  const under = valid(background) ? [background] : [];
  const vars: Record<string, string> = {};
  for (const [variable] of FRAME_COLOURS) {
    const value = style.getPropertyValue(variable).trim();
    if (valid(value)) {
      vars[variable] = paint([...under, value]);
    }
  }
  return vars;
}

/** The structural slice of Monaco this file needs. */
type ThemeHost = {
  editor: {
    defineTheme(
      name: string,
      data: {
        base: 'vs' | 'vs-dark';
        inherit: boolean;
        rules: ThemeRule[];
        colors: Record<string, string>;
      }
    ): void;
  };
};

/** Defines both themes from Orca's current variables; run again on each `theme` event. */
export function defineThemes(monaco: ThemeHost): void {
  const colors = themeColors(readOrcaVars());
  monaco.editor.defineTheme(THEME_NAME.dark, {
    base: 'vs-dark',
    inherit: true,
    rules: themeRules(true),
    colors,
  });
  monaco.editor.defineTheme(THEME_NAME.light, {
    base: 'vs',
    inherit: true,
    rules: themeRules(false),
    colors,
  });
}
