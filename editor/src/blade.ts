// Blade for Monaco: a copy of Monaco's HTML grammar with Blade's comments, echoes, directives and components layered on top.
// No Monaco import, so Node can test it.
//
// Monarch quirks the rules below depend on: a rule only matches at the current position (no lookbehind past it), `@name` in a regex expands a grammar attribute so a literal `@` is written
// `@@`, and the first matching rule of a state wins.
// Monarch also rebuilds each rule from its regex's `source` with the grammar's own flags (`ignoreCase`, `unicode`), so the `u` on these literals only proves the source is valid in unicode mode.

interface MonarchLanguage {
  tokenizer: Record<string, unknown[]>;
}
type Rule = unknown;

const PHP_KEYWORDS = [
  'fn',
  'function',
  'new',
  'return',
  'true',
  'false',
  'null',
  'and',
  'or',
  'not',
  'instanceof',
];

/** PHP inside `{{ }}`, `{!! !!}`, directive arguments, `@php` blocks and bound component attributes. */
const bladeExpression: Rule[] = [
  [/\s+/u, ''],
  [/\$[a-zA-Z_]\w*/u, 'variable'],
  [/"(?:[^"\\]|\\.)*"/u, 'string'],
  [/'(?:[^'\\]|\\.)*'/u, 'string'],
  [/\d+(?:\.\d+)?/u, 'number'],
  [/\?->|->|::|=>/u, 'delimiter'],
  [/[()]/u, 'delimiter.parenthesis'],
  [/[[\]]/u, 'delimiter.square'],
  [new RegExp(`(?:${PHP_KEYWORDS.join('|')})\\b`, 'u'), 'keyword'],
  [/[a-zA-Z_\\][\w\\]*/u, 'identifier'],
  [/./u, ''],
];

/**
 * Blade's own syntax, tried before any HTML rule of a state. `text` is the token for what Blade
 * leaves as it is (`@@if`, `@{{`), so it reads like the text around it.
 */
function bladeRules(text: string): Rule[] {
  return [
    // First on purpose: `{{` is the most common construct; `{{--` is a comment.
    [/\{\{(?!--)/u, 'delimiter.blade', '@bladeEcho'],
    [/\{\{--/u, 'comment.blade', '@bladeComment'],
    [/\{!!/u, 'delimiter.blade', '@bladeRaw'],
    // `@{{ … }}` and `@@if` are printed as they are, for JavaScript frameworks.
    [/@@\{\{/u, text],
    [/@@@@\w*/u, text],
    [/@@verbatim\b/u, 'keyword.blade', '@bladeVerbatim'],
    [
      /(?<directive>@@[a-zA-Z_]\w*)(?<space>\s*)(?<open>\()/u,
      ['keyword.blade', '', { next: '@bladeArguments', token: 'delimiter.parenthesis' }],
    ],
    [/@@php\b/u, 'keyword.blade', '@bladePhp'],
    [/@@[a-zA-Z_]\w*/u, 'keyword.blade'],
  ];
}

/**
 * Plain text that must not hide Blade: a word with an `@` after it is an email address, not a
 * directive, so a word swallows the `@`s that follow it; anything else stops at `<`, `@` and `{`.
 * Needed because HTML's catch-all text rules (`[^<]+`) would otherwise swallow a whole line.
 */
function textRules(text: string, stop: string): Rule[] {
  return [
    [new RegExp(`[^${stop}@@{\\w]+`, 'u'), text],
    [/\w+(?:@@\w*)*/u, text],
    [/[@@{]/u, text],
  ];
}

/** A quoted attribute value in a state of its own, so Blade inside it is found. */
function attributeValue(quote: '"' | "'"): Rule[] {
  return [
    ...bladeRules('attribute.value'),
    [new RegExp(quote, 'u'), 'attribute.value', '@pop'],
    ...textRules('attribute.value', quote),
  ];
}

/** HTML's attribute rules, for `<x-…>` components. */
const componentAttributes: Rule[] = [
  [/\/?>/u, 'delimiter', '@pop'],
  [/"/u, 'attribute.value', '@bladeAttributeValueDouble'],
  [/'/u, 'attribute.value', '@bladeAttributeValueSingle'],
  [/[\w-]+/u, 'attribute.name'],
  [/[=]/u, 'delimiter'],
  [/[ \t\r\n]+/u, ''],
];

// States that are not tags or text: HTML comments, the doctype, and script and style bodies, which belong to the embedded JavaScript and CSS grammars.
const NOT_BLADE = /comment|doctype|embedded/iu;

/** HTML's one-regex quoted values (`/"([^"]*)"/`), which would swallow `{{ }}` inside a value. */
function quotedValue(rule: Rule): '"' | "'" | null {
  if (
    !Array.isArray(rule) ||
    !(rule[0] instanceof RegExp) ||
    rule[1] !== 'attribute.value' ||
    rule.length !== 2
  ) {
    return null;
  }
  if (rule[0].source === '"([^"]*)"') return '"';
  if (rule[0].source === "'([^']*)'") return "'";
  return null;
}

function bladeGrammar<C extends object, L extends MonarchLanguage>(html: {
  conf: C;
  language: L;
}): { conf: C; language: L } {
  const language = structuredClone(html.language);
  const { tokenizer } = language;
  for (const [state, rules] of Object.entries(tokenizer)) {
    if (state === 'root' || NOT_BLADE.test(state)) {
      continue;
    }
    const opened = rules.map((rule) => {
      const quote = quotedValue(rule);
      return quote
        ? [
            new RegExp(quote, 'u'),
            'attribute.value',
            quote === '"' ? '@bladeAttributeValueDouble' : '@bladeAttributeValueSingle',
          ]
        : rule;
    });
    tokenizer[state] = [...bladeRules(''), ...opened];
  }
  tokenizer.root = [
    ...bladeRules(''),
    [
      /(?<open><\/?)(?<tag>x-[\w\-.:]+)/u,
      ['delimiter', { next: '@bladeComponent', token: 'tag.blade' }],
    ],
    ...textRules('', '<'),
    ...tokenizer.root,
  ];
  Object.assign(tokenizer, {
    // Balanced parentheses, so `@if(count($a) > 1)` ends at the right one, across lines too.
    bladeArguments: [
      [/\(/u, 'delimiter.parenthesis', '@push'],
      [/\)/u, 'delimiter.parenthesis', '@pop'],
      { include: '@bladeExpression' },
    ],
    bladeAttributeValueDouble: attributeValue('"'),
    bladeAttributeValueSingle: attributeValue("'"),
    bladeBoundDouble: [[/"/u, 'delimiter', '@pop'], { include: '@bladeExpression' }],
    bladeBoundSingle: [[/'/u, 'delimiter', '@pop'], { include: '@bladeExpression' }],
    bladeComment: [
      [/--\}\}/u, 'comment.blade', '@pop'],
      [/[^-]+/u, 'comment.blade'],
      [/./u, 'comment.blade'],
    ],
    bladeComponent: [
      ...bladeRules(''),
      // Monarch matches every rule at the current position anyway; the `^` inside the group says so, so an unanchored search cannot restart inside a run of `:`s.
      // A `^` as the very first character would instead make Monarch try the rule only at the start of a line.
      [
        // oxlint-disable-next-line eslint/prefer-named-capture-group -- Monarch maps each group to the action at its position
        /(^:[\w\-.:]+)(\s*)(=)(\s*)(")/u,
        ['attribute.name', '', 'delimiter', '', { next: '@bladeBoundDouble', token: 'delimiter' }],
      ],
      [
        // oxlint-disable-next-line eslint/prefer-named-capture-group -- Monarch maps each group to the action at its position
        /(^:[\w\-.:]+)(\s*)(=)(\s*)(')/u,
        ['attribute.name', '', 'delimiter', '', { next: '@bladeBoundSingle', token: 'delimiter' }],
      ],
      ...componentAttributes,
    ],
    bladeEcho: [[/\}\}/u, 'delimiter.blade', '@pop'], { include: '@bladeExpression' }],
    bladeExpression,
    bladePhp: [[/@@endphp\b/u, 'keyword.blade', '@pop'], { include: '@bladeExpression' }],
    bladeRaw: [[/!!\}/u, 'delimiter.blade', '@pop'], { include: '@bladeExpression' }],
    bladeVerbatim: [
      [/@@endverbatim\b/u, 'keyword.blade', '@pop'],
      [/[^@@]+/u, ''],
      [/@@/u, ''],
    ],
  });
  return {
    conf: { ...html.conf, comments: { blockComment: ['{{--', '--}}'] } },
    language,
  };
}

export { bladeGrammar };
export type { MonarchLanguage };
