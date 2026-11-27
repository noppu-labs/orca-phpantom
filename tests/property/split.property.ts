import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REQUEST_BUDGET_BYTES, chunkText, encodedSize } from '../../editor/src/split.ts';
import { anyText, fc } from './setup.ts';

// Default-sized strings never reach the real budget, so the small budgets are what make chunkText cut.
// The smallest is what splitOne passes; any budget of at least 8 (two quotes and a six-byte escape) holds every unit.
const budget = fc.oneof(
  fc.integer({ min: 16, max: 32 }),
  fc.integer({ min: 16, max: 256 }),
  fc.constant(REQUEST_BUDGET_BYTES)
);

// A short run repeated past the real budget, so the default budget cuts too.
const long = fc
  .tuple(anyText({ minLength: 1, maxLength: 32 }), fc.integer({ min: 1, max: 4 }))
  .map(([run, factor]) => run.repeat(Math.ceil((REQUEST_BUDGET_BYTES * factor) / run.length / 4)));

// Line breaks and astral characters packed close, so cuts often land beside a CR LF or a surrogate pair.
const dense = fc
  .array(
    fc.oneof(
      { arbitrary: anyText({ maxLength: 4 }), weight: 1 },
      { arbitrary: fc.constantFrom('\r\n', '\n', '\r', '\u{1F600}'), weight: 3 }
    ),
    { size: 'medium' }
  )
  .map((parts) => parts.join(''));

const text = fc.oneof(anyText(), dense, long);

const isHigh = (unit: number): boolean => unit >= 0xd8_00 && unit <= 0xdb_ff;
const isLow = (unit: number): boolean => unit >= 0xdc_00 && unit <= 0xdf_ff;

test('chunkText chunks join back to the text', () => {
  fc.assert(
    fc.property(text, budget, (input, limit) => {
      assert.equal(chunkText(input, limit).join(''), input);
      assert.equal(chunkText(input).join(''), input);
    })
  );
});

test('every chunk fits the request budget', () => {
  fc.assert(
    fc.property(text, budget, (input, limit) => {
      for (const chunk of chunkText(input)) assert.ok(encodedSize(chunk) <= REQUEST_BUDGET_BYTES);
      for (const chunk of chunkText(input, limit)) assert.ok(encodedSize(chunk) <= limit);
    })
  );
});

test('no cut separates a CR from its LF or the halves of a surrogate pair', () => {
  fc.assert(
    fc.property(text, budget, (input, limit) => {
      const chunks = chunkText(input, limit);
      for (let index = 1; index < chunks.length; index++) {
        const before = chunks[index - 1].codePointAt(chunks[index - 1].length - 1) ?? 0;
        const after = chunks[index].codePointAt(0) ?? 0;
        assert.ok(!(before === 0x0d && after === 0x0a), `cut between CR and LF at chunk ${index}`);
        assert.ok(
          !(isHigh(before) && isLow(after)),
          `cut inside a surrogate pair at chunk ${index}`
        );
      }
    })
  );
});
