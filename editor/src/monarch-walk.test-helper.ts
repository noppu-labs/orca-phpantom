// A small Monarch tokenizer for tests: it runs a grammar's rules over a line the way Monaco's
// monarchLexer does (rules anchored at the position, first match wins, `@@` is a literal `@`, groups,
// `include`, `next`/`switchTo`/`@pop`, repeated token types merged), so grammars can be tested in
// Node without Monaco. It throws where Monarch would, so a broken rule fails here and not in the frame.

type Action = string | { token?: string; next?: string; switchTo?: string; [key: string]: unknown }
type Grammar = { language: { tokenizer: { [state: string]: readonly unknown[] }; ignoreCase?: boolean; defaultToken?: string } }
export type Token = { type: string; text: string }

function compile(grammar: Grammar, regex: RegExp): RegExp {
  const source = regex.source.replace(/@@/g, '\x01')
  const attribute = /@(\w+)/.exec(source)
  if (attribute) {
    throw new Error(`regex refers to @${attribute[1]}, which this walker does not expand: /${regex.source}/`)
  }
  const flags = grammar.language.ignoreCase ? 'i' : ''
  return new RegExp(`^(?:${source.replace(/\x01/g, '@')})`, flags)
}

function rulesOf(grammar: Grammar, state: string, seen: string[] = []): unknown[] {
  const tokenizer = grammar.language.tokenizer
  let name = state
  // Monarch's parent matching: `scriptWithCustomType.text/javascript` uses `scriptWithCustomType`.
  while (!(name in tokenizer) && name.includes('.')) {
    name = name.slice(0, name.lastIndexOf('.'))
  }
  if (!(name in tokenizer)) {
    throw new Error(`tokenizer state is not defined: ${state}`)
  }
  if (seen.includes(name)) {
    throw new Error(`include cycle: ${[...seen, name].join(' > ')}`)
  }
  const rules: unknown[] = []
  for (const rule of tokenizer[name]) {
    if (rule && typeof rule === 'object' && !Array.isArray(rule) && 'include' in rule) {
      rules.push(...rulesOf(grammar, String((rule as { include: string }).include).replace(/^@/, ''), [...seen, name]))
    } else {
      rules.push(rule)
    }
  }
  return rules
}

function asRule(rule: unknown): { regex: RegExp; action: Action | Action[]; next?: string } {
  if (Array.isArray(rule) && rule[0] instanceof RegExp) {
    return { regex: rule[0], action: rule[1] ?? '', next: rule[2] as string | undefined }
  }
  throw new Error(`unsupported rule shape: ${JSON.stringify(rule)}`)
}

/** The first rule of `state`, compiled as Monarch compiles it. */
export function firstRuleRegex(grammar: Grammar, state: string): RegExp {
  return compile(grammar, asRule(rulesOf(grammar, state)[0]).regex)
}

/** Tokenizes one line from `stack` (which it updates), returning Monaco's merged tokens. */
export function tokenizeLine(grammar: Grammar, line: string, stack: string[] = ['root']): Token[] {
  const tokens: Token[] = []
  const emit = (type: string, text: string): void => {
    if (text === '') {
      return
    }
    const last = tokens[tokens.length - 1]
    // Monaco's token collector drops a token of the same type as the one before it.
    if (last && last.type === type) {
      last.text += text
    } else {
      tokens.push({ type, text })
    }
  }
  const move = (next: string | undefined, switchTo: string | undefined): void => {
    if (switchTo) {
      rulesOf(grammar, switchTo.replace(/^@/, ''))
      stack[stack.length - 1] = switchTo.replace(/^@/, '')
    }
    if (!next) {
      return
    }
    if (next === '@pop') {
      if (stack.length <= 1) {
        throw new Error('cannot pop the root state')
      }
      stack.pop()
    } else if (next === '@push') {
      stack.push(stack[stack.length - 1])
    } else if (next === '@popall') {
      stack.splice(1)
    } else {
      if (next.includes('$')) {
        throw new Error(`this walker does not substitute ${next}`)
      }
      rulesOf(grammar, next.replace(/^@/, ''))
      stack.push(next.replace(/^@/, ''))
    }
  }
  const apply = (action: Action, text: string): void => {
    if (typeof action === 'string') {
      emit(action, text)
      return
    }
    if ('cases' in action || action.token === '@rematch' || 'nextEmbedded' in action) {
      throw new Error(`this walker does not support ${JSON.stringify(action)}`)
    }
    emit(action.token ?? '', text)
    move(action.next, action.switchTo)
  }

  let pos = 0
  while (pos < line.length) {
    const state = stack[stack.length - 1]
    const rest = line.slice(pos)
    let matched: { rule: ReturnType<typeof asRule>; match: RegExpMatchArray } | null = null
    for (const raw of rulesOf(grammar, state)) {
      const rule = asRule(raw)
      const match = rest.match(compile(grammar, rule.regex))
      if (match) {
        matched = { rule, match }
        break
      }
    }
    if (!matched) {
      // Monarch's fallback: one character of the default token.
      emit(grammar.language.defaultToken ?? '', line[pos])
      pos += 1
      continue
    }
    const { rule, match } = matched
    const depth = stack.length
    if (Array.isArray(rule.action)) {
      if (match.length !== rule.action.length + 1) {
        throw new Error(`matched number of groups does not match the number of actions: /${rule.regex.source}/`)
      }
      if (match.slice(1).join('') !== match[0]) {
        throw new Error(`groups must cover the whole match: /${rule.regex.source}/`)
      }
      rule.action.forEach((action, index) => apply(action, match[index + 1] ?? ''))
    } else {
      apply(rule.action, match[0])
    }
    move(rule.next, undefined)
    if (match[0].length === 0 && stack.length === depth && stack[stack.length - 1] === state) {
      throw new Error(`no progress in tokenizer in rule: /${rule.regex.source}/`)
    }
    pos += match[0].length
  }
  return tokens
}

/** Token types of `lines` (tokenized in order), without plain text ('') and bare HTML punctuation ('delimiter'). */
export function tokenTypes(grammar: Grammar, ...lines: string[]): string[] {
  const stack = ['root']
  return lines
    .flatMap((line) => tokenizeLine(grammar, line, stack))
    .map((token) => token.type)
    .filter((type) => type !== '' && type !== 'delimiter')
}
