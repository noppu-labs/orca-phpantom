// The editor's two themes: Monaco's stock dark and light token colours, a rule for every semantic token PHPantom sends, and editor chrome in Orca's colours. Monaco comes in as a parameter, so Node can test it.
import type { HostResult } from 'orca/host';

/** What `editor.readTypography` answers and `editor.typography.changed` carries. */
type EditorTypography = HostResult<'editor.readTypography'>;

/** PHPantom's semantic token legend, in its order. */
const SEMANTIC_TYPES: readonly string[] = [
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
const SEMANTIC_MODIFIERS: readonly string[] = [
  'declaration',
  'static',
  'readonly',
  'deprecated',
  'abstract',
  'definition',
  'defaultLibrary',
];

const THEME_NAME = { dark: 'phpantom-dark', light: 'phpantom-light' } as const;
const HEX = 16;

type Base = 'variable' | 'type' | 'keyword' | 'comment' | 'annotation';

// Monaco's own `vs-dark` and `vs` rules (editor/standalone/common/themes.js).
// Neither has a function colour, so functions and methods keep the editor's foreground, as they do without semantic tokens.
const BASE_COLOURS: Record<'dark' | 'light', Record<Base, string>> = {
  dark: {
    annotation: 'cc6666',
    comment: '608B4E',
    keyword: '569CD6',
    type: '3DC9B0',
    variable: '74B0DF',
  },
  light: {
    annotation: '808080',
    comment: '008000',
    keyword: '0000FF',
    type: '008080',
    variable: '001188',
  },
};

const NEAREST: Record<string, Base | null> = {
  class: 'type',
  comment: 'comment',
  decorator: 'annotation',
  enum: 'type',
  enumMember: 'variable',
  function: null,
  interface: 'type',
  keyword: 'keyword',
  method: null,
  namespace: 'type',
  parameter: 'variable',
  property: 'variable',
  type: 'type',
  typeParameter: 'type',
  variable: 'variable',
};

interface ThemeRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/**
 * Monaco styles a semantic token by the rule matching `type.mod1.mod2…` (modifiers in legend order)
 * or its longest dot-prefix, with no wildcards. So every type gets a rule for each non-empty subset of
 * the modifiers: static ones are italic and deprecated ones struck through, whatever else they carry.
 */
function themeRules(dark: boolean): ThemeRule[] {
  const colours = BASE_COLOURS[dark ? 'dark' : 'light'];
  const rules: ThemeRule[] = [];
  for (const type of SEMANTIC_TYPES) {
    const nearest = NEAREST[type];
    const colour = nearest ? { foreground: colours[nearest] } : {};
    rules.push({ token: type, ...colour });
    // oxlint-disable-next-line eslint/no-bitwise -- each bit of mask stands for one semantic modifier, so the loop visits every combination
    for (let mask = 1; mask < 1 << SEMANTIC_MODIFIERS.length; mask++) {
      // oxlint-disable-next-line eslint/no-bitwise -- keeps the modifiers whose bit is set in mask
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
function themeColors(vars: Record<string, string>): Record<string, string> {
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
function typographyOptions(t: EditorTypography): {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
  fontLigatures: boolean;
  wordWrap: 'on' | 'off';
  minimap: { enabled: boolean };
} {
  return {
    fontFamily: t.cssFontFamily,
    fontLigatures: t.fontLigatures,
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    lineHeight: t.lineHeight,
    minimap: { enabled: t.minimap },
    wordWrap: t.wordWrap,
  };
}

/**
 * Reads Orca's frame variables as `#rrggbb`, whatever CSS colour syntax they use, by painting each on
 * a 1×1 canvas. A translucent colour is painted over the background first, as the page shows it.
 */
function readOrcaVars(): Record<string, string> {
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
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return `#${[red, green, blue].map((channel) => channel.toString(HEX).padStart(2, '0')).join('')}`;
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
interface ThemeHost {
  editor: {
    defineTheme: (
      name: string,
      data: {
        base: 'vs' | 'vs-dark';
        inherit: boolean;
        rules: ThemeRule[];
        colors: Record<string, string>;
      }
    ) => void;
  };
}

/** Defines both themes from Orca's current variables; run again on each `theme` event. */
function defineThemes(monaco: ThemeHost): void {
  const colors = themeColors(readOrcaVars());
  monaco.editor.defineTheme(THEME_NAME.dark, {
    base: 'vs-dark',
    colors,
    inherit: true,
    rules: themeRules(true),
  });
  monaco.editor.defineTheme(THEME_NAME.light, {
    base: 'vs',
    colors,
    inherit: true,
    rules: themeRules(false),
  });
}

export {
  SEMANTIC_TYPES,
  SEMANTIC_MODIFIERS,
  THEME_NAME,
  themeRules,
  themeColors,
  typographyOptions,
  readOrcaVars,
  defineThemes,
};
export type { EditorTypography, ThemeRule };
