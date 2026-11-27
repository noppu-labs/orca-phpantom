// `blade.test.ts` — run the Monarch rules' regexes over sample lines; no Monaco import.
import { assert, test } from 'orca/testing';

import { bladeGrammar, type MonarchLanguage } from '../../editor/src/blade.ts';
import { firstRuleRegex, tokenTypes } from '../helpers/monarch-walk.ts';

// The parts of Monaco's HTML grammar that matter here: a catch-all text rule in root, a one-regex quoted value (as Monaco's `otherTag` has) and a quoted value with a state of its own.
function fakeHtml() {
  return {
    conf: { comments: { blockComment: ['<!--', '-->'] as [string, string] } },
    language: {
      defaultToken: '',
      tokenPostfix: '.html',
      ignoreCase: true,
      tokenizer: {
        root: [
          // oxlint-disable-next-line eslint/prefer-named-capture-group -- Monarch maps each group to the action at its position, as in Monaco's HTML grammar
          [/(<)((?:[\w-]+:)?[\w-]+)/u, ['delimiter', { token: 'tag', next: '@tag' }]],
          // oxlint-disable-next-line eslint/prefer-named-capture-group -- Monarch maps each group to the action at its position, as in Monaco's HTML grammar
          [/(<\/)((?:[\w-]+:)?[\w-]+)/u, ['delimiter', { token: 'tag', next: '@tag' }]],
          [/</u, 'delimiter'],
          [/[^<]+/u],
        ],
        tag: [
          [/\/?>/u, 'delimiter', '@pop'],
          [/"/u, 'attribute.value', '@attributeValue'],
          // oxlint-disable-next-line eslint/prefer-named-capture-group -- bladeGrammar finds this rule by its source, as Monaco's HTML grammar writes it
          [/'([^']*)'/u, 'attribute.value'],
          [/[\w-]+/u, 'attribute.name'],
          [/[=]/u, 'delimiter'],
          [/[ \t\r\n]+/u],
        ],
        attributeValue: [
          [/"/u, 'attribute.value', '@pop'],
          [/[^"]+/u, 'attribute.value'],
        ],
      },
    },
  };
}

test('keeps every HTML state and puts Blade rules first in root', () => {
  const g = bladeGrammar(fakeHtml());
  for (const state of Object.keys(fakeHtml().language.tokenizer)) {
    assert.ok(state in g.language.tokenizer);
  }
  assert.match('{{ $user->name }}', firstRuleRegex(g, 'root'));
});
test('tokenizes the Blade constructs', () => {
  assert.deepEqual(
    tokenTypes(
      bladeGrammar(fakeHtml()),
      '@if($a) {{-- note --}} {!! $b !!} <x-alert :user="$u" />'
    ),
    [
      'keyword.blade',
      'delimiter.parenthesis',
      'variable',
      'delimiter.parenthesis',
      'comment.blade',
      'delimiter.blade',
      'variable',
      'delimiter.blade',
      'tag.blade',
      'attribute.name',
      'variable',
    ]
  );
});
test('does not treat an email address as a directive', () => {
  assert.ok(!tokenTypes(bladeGrammar(fakeHtml()), 'mail me@example.com').includes('keyword.blade'));
});
test('finds echoes and directives in the middle of text', () => {
  assert.deepEqual(tokenTypes(bladeGrammar(fakeHtml()), 'Hello {{ $name }}, @lang("hi") now'), [
    'delimiter.blade',
    'variable',
    'delimiter.blade',
    'keyword.blade',
    'delimiter.parenthesis',
    'string',
    'delimiter.parenthesis',
  ]);
});
test('finds echoes inside quoted attribute values', () => {
  assert.deepEqual(
    tokenTypes(bladeGrammar(fakeHtml()), `<a title='x {{ $t }}' href="{{ route('home') }}">`),
    [
      'tag',
      'attribute.name',
      'attribute.value',
      'delimiter.blade',
      'variable',
      'delimiter.blade',
      'attribute.value',
      'attribute.name',
      'attribute.value',
      'delimiter.blade',
      'identifier',
      'delimiter.parenthesis',
      'string',
      'delimiter.parenthesis',
      'delimiter.blade',
      'attribute.value',
    ]
  );
});
test('leaves escaped and verbatim Blade alone', () => {
  const g = bladeGrammar(fakeHtml());
  assert.deepEqual(tokenTypes(g, '@@if @{{ $x }}'), []);
  assert.deepEqual(tokenTypes(g, '@verbatim', '{{ $x }} @if', '@endverbatim {{ $y }}'), [
    'keyword.blade',
    'keyword.blade',
    'delimiter.blade',
    'variable',
    'delimiter.blade',
  ]);
});
test('tokenizes @php blocks and multi-line directive arguments as PHP', () => {
  const g = bladeGrammar(fakeHtml());
  assert.deepEqual(tokenTypes(g, '@php', '$n = fn() => new Foo(1);', '@endphp'), [
    'keyword.blade',
    'variable',
    'keyword',
    'delimiter.parenthesis',
    'keyword',
    'identifier',
    'delimiter.parenthesis',
    'number',
    'delimiter.parenthesis',
    'keyword.blade',
  ]);
  assert.deepEqual(tokenTypes(g, '@foreach ($items', '  as $item)', '<p>'), [
    'keyword.blade',
    'delimiter.parenthesis',
    'variable',
    'identifier',
    'variable',
    'delimiter.parenthesis',
    'tag',
  ]);
});
test('comments Blade with {{-- --}}', () => {
  assert.deepEqual(bladeGrammar(fakeHtml()).conf.comments, { blockComment: ['{{--', '--}}'] });
});
test('tokenizes bound component attributes in both quotes', () => {
  const g = bladeGrammar(fakeHtml());
  for (const line of [`<x-alert :user="$u" />`, `<x-alert :user='$u' />`]) {
    assert.deepEqual(tokenTypes(g, line), ['tag.blade', 'attribute.name', 'variable']);
  }
});
test('scans a 5,000-character bound attribute name in linear time', () => {
  const g = bladeGrammar(fakeHtml());
  const tokenizer: MonarchLanguage['tokenizer'] = g.language.tokenizer;
  const bound = tokenizer.bladeComponent.filter(
    (rule): rule is [RegExp, unknown[]] =>
      Array.isArray(rule) && Array.isArray(rule[1]) && rule[1][0] === 'attribute.name'
  );
  assert.equal(bound.length, 2);
  const name = 'a'.repeat(5000);
  const run = ':'.repeat(5000);
  const started = performance.now();
  for (const [regex] of bound) {
    // A leading `^` would make Monarch try the rule only at the start of a line.
    assert.ok(!regex.source.startsWith('^'), regex.source);
    assert.ok(!regex.test(`${run} `));
  }
  assert.deepEqual(tokenTypes(g, `<x-alert :${name}="$u" :${name}='$u' />`), [
    'tag.blade',
    'attribute.name',
    'variable',
    'attribute.name',
    'variable',
  ]);
  assert.deepEqual(tokenTypes(g, `<x-alert :${name} />`), ['tag.blade', 'attribute.name']);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `took ${elapsed} ms`);
});
test('the walker compiles `@@` to a literal `@`', () => {
  const endphp = firstRuleRegex(bladeGrammar(fakeHtml()), 'bladePhp');
  assert.equal(endphp.source, String.raw`^(?:@endphp\b)`);
  assert.match('@endphp', endphp);
  assert.ok(!endphp.test('@@endphp'));
});
test('leaves comments, the doctype and embedded script and style states without Blade rules', () => {
  const html = fakeHtml();
  const comment = [[/-->/u, 'comment', '@pop']];
  const doctype = [[/>/u, 'metatag', '@pop']];
  const scriptEmbedded = [[/<\/script/u, { token: '@rematch', next: '@pop' }]];
  const tokenizer: Record<string, unknown[]> = {
    ...html.language.tokenizer,
    comment,
    doctype,
    scriptEmbedded,
  };
  const g = bladeGrammar({ ...html, language: { ...html.language, tokenizer } });
  assert.deepEqual(g.language.tokenizer.comment, comment);
  assert.deepEqual(g.language.tokenizer.doctype, doctype);
  assert.deepEqual(g.language.tokenizer.scriptEmbedded, scriptEmbedded);
  assert.match('{{ $x }}', firstRuleRegex(g, 'tag'));
});
