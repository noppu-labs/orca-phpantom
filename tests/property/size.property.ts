import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fitsIn, leadingThatFit, orcaSize } from '../../src/utils/size.ts';
import { fc } from './setup.ts';

test('orcaSize is finite and non-negative for JSON values', () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const { bytes, objects } = orcaSize(value);
      assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, `bytes ${bytes}`);
      assert.ok(Number.isSafeInteger(objects) && objects >= 0, `objects ${objects}`);
    })
  );
});

test('leadingThatFit returns a prefix that fits', () => {
  fc.assert(
    fc.property(
      fc.array(fc.jsonValue()),
      fc.nat({ max: 4096 }),
      fc.nat({ max: 64 }),
      (items, spareBytes, spareObjects) => {
        // The answer as router.ts measures a cut list: the list itself and the count beside it.
        const answer = (list: unknown[]) => ({ result: list, truncated: items.length });
        const envelope = orcaSize(answer([]));
        const limit = {
          bytes: envelope.bytes + spareBytes,
          objects: envelope.objects + spareObjects,
        };

        const kept = leadingThatFit(items, envelope, limit);

        assert.ok(kept.length <= items.length);
        for (const [index, item] of kept.entries()) assert.equal(item, items[index]);
        assert.ok(fitsIn(orcaSize(answer(kept)), limit));
        if (kept.length < items.length) {
          assert.ok(!fitsIn(orcaSize(answer(items.slice(0, kept.length + 1))), limit));
        }
      }
    )
  );
});
