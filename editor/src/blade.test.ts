// blade.test.ts — run the Monarch rules' regexes over sample lines; no Monaco import.
import { assert, test } from 'orca/testing'
import { bladeGrammar } from './blade.ts'
import { firstRuleRegex, tokenTypes } from './monarch-walk.test-helper.ts'

// The parts of Monaco's HTML grammar that matter here: a catch-all text rule in root, a one-regex
// quoted value (as Monaco's `otherTag` has) and a quoted value with a state of its own.
function fakeHtml() {
  return {
    conf: { comments: { blockComment: ['<!--', '-->'] as [string, string] } },
    language: {
      defaultToken: '',
      tokenPostfix: '.html',
      ignoreCase: true,
      tokenizer: {
        root: [
          [/(<)((?:[\w\-]+:)?[\w\-]+)/, ['delimiter', { token: 'tag', next: '@tag' }]],
          [/(<\/)((?:[\w\-]+:)?[\w\-]+)/, ['delimiter', { token: 'tag', next: '@tag' }]],
          [/</, 'delimiter'],
          [/[^<]+/]
        ],
        tag: [
          [/\/?>/, 'delimiter', '@pop'],
          [/"/, 'attribute.value', '@attributeValue'],
          [/'([^']*)'/, 'attribute.value'],
          [/[\w\-]+/, 'attribute.name'],
          [/=/, 'delimiter'],
          [/[ \t\r\n]+/]
        ],
        attributeValue: [
          [/"/, 'attribute.value', '@pop'],
          [/[^"]+/, 'attribute.value']
        ]
      }
    }
  }
}

test('keeps every HTML state and puts Blade rules first in root', () => {
  const g = bladeGrammar(fakeHtml())
  for (const state of Object.keys(fakeHtml().language.tokenizer)) assert.ok(state in g.language.tokenizer)
  assert.match('{{ $user->name }}', firstRuleRegex(g, 'root'))
})
test('tokenizes the Blade constructs', () => {
  assert.deepEqual(tokenTypes(bladeGrammar(fakeHtml()), "@if($a) {{-- note --}} {!! $b !!} <x-alert :user=\"$u\" />"),
    ['keyword.blade', 'delimiter.parenthesis', 'variable', 'delimiter.parenthesis', 'comment.blade', 'delimiter.blade', 'variable', 'delimiter.blade', 'tag.blade', 'attribute.name', 'variable'])
})
test('does not treat an email address as a directive', () => {
  assert.ok(!tokenTypes(bladeGrammar(fakeHtml()), 'mail me@example.com').includes('keyword.blade'))
})
test('finds echoes and directives in the middle of text', () => {
  assert.deepEqual(tokenTypes(bladeGrammar(fakeHtml()), 'Hello {{ $name }}, @lang("hi") now'),
    ['delimiter.blade', 'variable', 'delimiter.blade', 'keyword.blade', 'delimiter.parenthesis', 'string', 'delimiter.parenthesis'])
})
test('finds echoes inside quoted attribute values', () => {
  assert.deepEqual(tokenTypes(bladeGrammar(fakeHtml()), `<a title='x {{ $t }}' href="{{ route('home') }}">`),
    ['tag', 'attribute.name', 'attribute.value', 'delimiter.blade', 'variable', 'delimiter.blade', 'attribute.value',
      'attribute.name', 'attribute.value', 'delimiter.blade', 'identifier', 'delimiter.parenthesis', 'string', 'delimiter.parenthesis', 'delimiter.blade', 'attribute.value'])
})
test('leaves escaped and verbatim Blade alone', () => {
  const g = bladeGrammar(fakeHtml())
  assert.deepEqual(tokenTypes(g, '@@if @{{ $x }}'), [])
  assert.deepEqual(tokenTypes(g, '@verbatim', '{{ $x }} @if', '@endverbatim {{ $y }}'),
    ['keyword.blade', 'keyword.blade', 'delimiter.blade', 'variable', 'delimiter.blade'])
})
test('tokenizes @php blocks and multi-line directive arguments as PHP', () => {
  const g = bladeGrammar(fakeHtml())
  assert.deepEqual(tokenTypes(g, '@php', '$n = fn() => new Foo(1);', '@endphp'),
    ['keyword.blade', 'variable', 'keyword', 'delimiter.parenthesis', 'keyword', 'identifier', 'delimiter.parenthesis', 'number', 'delimiter.parenthesis', 'keyword.blade'])
  assert.deepEqual(tokenTypes(g, '@foreach ($items', '  as $item)', '<p>'),
    ['keyword.blade', 'delimiter.parenthesis', 'variable', 'identifier', 'variable', 'delimiter.parenthesis', 'tag'])
})
test('comments Blade with {{-- --}}', () => {
  assert.deepEqual(bladeGrammar(fakeHtml()).conf.comments, { blockComment: ['{{--', '--}}'] })
})
