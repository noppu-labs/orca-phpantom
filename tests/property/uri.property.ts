import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sameUri, uriKey } from '../../src/utils/uri.ts';
import { anyText, fc } from './setup.ts';

// Escapes and drive letters are where uriKey branches, so they are mixed into the text.
const uri = fc
  .array(
    fc.oneof(
      anyText(),
      fc.constantFrom('file://', 'file:///', 'C:', 'e%3A', '%3a', '%', '%E0%A4', '\\')
    )
  )
  .map((parts) => parts.join(''));

test('uriKey never throws', () => {
  fc.assert(
    fc.property(uri, (input) => {
      assert.equal(typeof uriKey(input), 'string');
    })
  );
});

test('sameUri is reflexive and symmetric', () => {
  fc.assert(
    fc.property(uri, uri, (left, right) => {
      assert.ok(sameUri(left, left));
      assert.equal(sameUri(left, right), sameUri(right, left));
    })
  );
});

test('a drive letter is the same file in either case and with its colon escaped', () => {
  const segment = fc.stringMatching(/^[\w.-]{1,12}$/u);
  fc.assert(
    fc.property(
      fc.constantFrom('A', 'C', 'E', 'Z'),
      fc.array(segment, { minLength: 1, maxLength: 4 }),
      (drive, segments) => {
        const path = segments.join('/');
        assert.ok(
          sameUri(`file:///${drive}:/${path}`, `file:///${drive.toLowerCase()}%3a/${path}`)
        );
        assert.ok(
          sameUri(`file:///${drive}:/${path}`, `file:///${drive}%3A\\${segments.join('\\')}`)
        );
      }
    )
  );
});
