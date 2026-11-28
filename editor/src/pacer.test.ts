import { assert, test } from 'orca/testing';

import { isRateLimited, Pacer } from './pacer.ts';

/** A refusal as Orca's frame shell builds it: an Error with `code`, `retryable` and, sometimes, `retryAfterMs`. */
function hostError(code: string, message: string, retryAfterMs?: number): Error {
  return Object.assign(new Error(message), {
    code,
    retryable: code === 'rate_limited',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

test('isRateLimited recognises only a rate_limited refusal', () => {
  assert.equal(isRateLimited(hostError('rate_limited', 'too many panel requests')), true);
  assert.equal(isRateLimited(hostError('unavailable', 'gone')), false);
  assert.equal(isRateLimited(new Error('rate_limited')), false);
  assert.equal(isRateLimited(null), false);
});

test('passive calls stop at the cap and resume as the window slides', () => {
  const time = clock();
  const pacer = new Pacer({ passiveCap: 3, windowMs: 10_000, now: time.now });
  for (let i = 0; i < 3; i++) {
    assert.equal(pacer.takePassive(), true);
    time.advance(1000);
  }
  assert.equal(pacer.takePassive(), false);
  // The first call ages out 10 s after it was made.
  time.advance(7000);
  assert.equal(pacer.takePassive(), true);
});

test('a refusal without retryAfterMs holds off, doubling up to the most', () => {
  const time = clock();
  const pacer = new Pacer({ firstBackoffMs: 1000, maxBackoffMs: 4000, now: time.now });
  const refusal = hostError('rate_limited', 'too many panel requests');
  assert.equal(pacer.refused(refusal), 1000);
  assert.equal(pacer.wait(), 1000);
  assert.equal(pacer.takePassive(), false);
  time.advance(1000);
  assert.equal(pacer.wait(), 0);
  assert.equal(pacer.refused(refusal), 2000);
  time.advance(2000);
  assert.equal(pacer.refused(refusal), 4000);
  time.advance(4000);
  assert.equal(pacer.refused(refusal), 4000);
});

test('refusals of calls already in flight during a hold do not lengthen it', () => {
  const time = clock();
  const pacer = new Pacer({ firstBackoffMs: 1000, now: time.now });
  const refusal = hostError('rate_limited', 'too many panel requests');
  pacer.refused(refusal);
  time.advance(100);
  assert.equal(pacer.refused(refusal), 900);
  assert.equal(pacer.wait(), 900);
});

test('honours retryAfterMs when Orca gives one', () => {
  const time = clock();
  const pacer = new Pacer({ firstBackoffMs: 1000, now: time.now });
  assert.equal(pacer.refused(hostError('rate_limited', 'Too many requests.', 3500)), 3500);
  assert.equal(pacer.wait(), 3500);
});

test('a success resets the backoff', () => {
  const time = clock();
  const pacer = new Pacer({ firstBackoffMs: 1000, now: time.now });
  const refusal = hostError('rate_limited', 'too many panel requests');
  pacer.refused(refusal);
  time.advance(1000);
  pacer.refused(refusal);
  time.advance(2000);
  pacer.succeeded();
  assert.equal(pacer.refused(refusal), 1000);
});

test('a retryAfterMs of 0 or a very large one is held between the shortest and the longest hold', () => {
  const time = clock();
  const pacer = new Pacer({ firstBackoffMs: 1000, maxBackoffMs: 10_000, now: time.now });
  assert.equal(pacer.refused(hostError('rate_limited', 'Too many requests.', 0)), 250);
  time.advance(250);
  assert.equal(pacer.refused(hostError('rate_limited', 'Too many requests.', 3_600_000)), 10_000);
});
