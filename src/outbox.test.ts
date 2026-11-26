import { assert, test } from 'orca/testing'
import { mock } from 'node:test'
import { Outbox } from './outbox.ts'

type Sent = { event: string; payload: unknown; panel: string; at: number }

function maxInAnyWindow(times: number[], windowMs: number): number {
  let most = 0
  let start = 0
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] >= windowMs) {
      start++
    }
    most = Math.max(most, end - start + 1)
  }
  return most
}

test('keeps posts under the rate limit and delivers the last set', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const posts: Sent[] = []
    let t = 0
    const outbox = new Outbox((event, payload, options) => posts.push({ event, payload, panel: options.panel, at: t }), { now: () => t, delayMs: 0 })
    const flushTimers = async (): Promise<void> => {
      // Why both clocks: the outbox reads `now` for its window and waits on (mocked) timers.
      for (let step = 0; step < 1200; step++) {
        t += 50
        mock.timers.tick(50)
        await Promise.resolve()
      }
    }
    const lastPayloadFor = (panel: string) => posts.filter((p) => p.panel === panel).at(-1)?.payload

    for (let i = 0; i < 500; i++) {
      outbox.send('p' + (i % 300), 'diag:' + (i % 300), 'phpantom.diagnostics', { n: i })
      t += 5
    }
    await flushTimers()
    const postTimes = posts.map((p) => p.at)
    assert.ok(maxInAnyWindow(postTimes, 10_000) <= 180, `at most 180 posts in any 10 s, saw ${maxInAnyWindow(postTimes, 10_000)}`)
    assert.equal(posts.length, 300)
    assert.deepEqual(lastPayloadFor('p299'), { n: 299 })
    assert.deepEqual(lastPayloadFor('p0'), { n: 300 })
    outbox.dispose()
  } finally {
    mock.timers.reset()
  }
})

test('truncates a diagnostics post over 240 KiB, most severe first', async () => {
  const posts: Sent[] = []
  const outbox = new Outbox((event, payload, options) => posts.push({ event, payload, panel: options.panel, at: 0 }), { delayMs: 0 })
  const severities = [4, 3, 2, 1]
  const diagnostics = Array.from({ length: 5000 }, (_, i) => ({
    range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
    severity: severities[i % 4],
    message: `diagnostic ${i} `.padEnd(60, '.')
  }))
  outbox.send('panel-1', 'diag:d1', 'phpantom.diagnostics', { docId: 'd1', diagnostics, truncated: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(posts.length, 1)
  const payload = posts[0].payload as { docId: string; diagnostics: { severity: number }[]; truncated: number }
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 240 * 1024)
  assert.equal(payload.docId, 'd1')
  assert.ok(payload.truncated > 0)
  assert.equal(payload.diagnostics.length + payload.truncated, 5000)
  assert.equal(payload.diagnostics.filter((d) => d.severity === 1).length, 1250)
  assert.equal(payload.diagnostics.filter((d) => d.severity === 4).length, 0)
  outbox.dispose()
})

test('a later send with the same key replaces the queued payload', async () => {
  const posts: Sent[] = []
  const outbox = new Outbox((event, payload, options) => posts.push({ event, payload, panel: options.panel, at: 0 }), { delayMs: 10 })
  outbox.send('panel-1', 'diag:d1', 'phpantom.diagnostics', { n: 1 })
  outbox.send('panel-1', 'diag:d1', 'phpantom.diagnostics', { n: 2 })
  outbox.send('panel-1', 'refresh:panel-1', 'phpantom.refresh', { kinds: ['inlayHints'] })
  assert.deepEqual(outbox.queued('refresh:panel-1'), { kinds: ['inlayHints'] })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(
    posts.map((p) => [p.event, p.payload]),
    [
      ['phpantom.diagnostics', { n: 2 }],
      ['phpantom.refresh', { kinds: ['inlayHints'] }]
    ]
  )
  assert.equal(outbox.queued('refresh:panel-1'), undefined)
  outbox.dispose()
})
