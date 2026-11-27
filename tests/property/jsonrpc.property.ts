import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RpcConnection } from '../../src/services/lsp/jsonrpc.ts';
import { anyText, fc } from './setup.ts';

const framed = (body: string): Buffer =>
  Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

function connect() {
  const notifications: { method: string; params: unknown }[] = [];
  const errors: string[] = [];
  const connection = new RpcConnection(() => undefined, {
    onRequest: () => null,
    onNotification: (method, params) => {
      notifications.push({ method, params });
    },
    onError: (message) => {
      errors.push(message);
    },
  });
  return { connection, notifications, errors };
}

const notification = fc.record({
  jsonrpc: fc.constant('2.0'),
  method: fc.string(),
  params: fc.jsonValue(),
});

// Raw bytes alone almost never hold a header, so frames with arbitrary bodies are mixed in.
const chunk = fc.oneof(
  fc.uint8Array(),
  fc.jsonValue().map((value) => framed(JSON.stringify(value))),
  notification.map((message) => framed(JSON.stringify(message))),
  anyText().map((text) => framed(text))
);

test('feed never throws on arbitrary bytes', () => {
  fc.assert(
    fc.property(fc.array(chunk), (chunks) => {
      const { connection } = connect();
      for (const piece of chunks) connection.feed(Buffer.from(piece));
    })
  );
});

test('messages arrive the same however the stream is chunked', () => {
  const message = fc.oneof(notification, fc.jsonValue());
  fc.assert(
    fc.property(fc.array(message), fc.array(fc.nat()), (messages, offsets) => {
      const stream = Buffer.concat(messages.map((sent) => framed(JSON.stringify(sent))));
      const cuts = [...new Set(offsets.map((offset) => offset % (stream.length + 1)))];
      // oxlint-disable-next-line unicorn/no-array-sort -- sorts the fresh array above in place; toSorted is past the ES2022 lib tsc checks against
      cuts.sort((left, right) => left - right);

      const whole = connect();
      whole.connection.feed(stream);
      const split = connect();
      let from = 0;
      for (const cut of [...cuts, stream.length]) {
        split.connection.feed(stream.subarray(from, cut));
        from = cut;
      }

      // The oracle is the JSON round trip: it turns -0 into 0, as the wire does.
      const expected = messages
        .filter(
          (sent) =>
            typeof sent === 'object' &&
            sent !== null &&
            !Array.isArray(sent) &&
            'method' in sent &&
            !('id' in sent)
        )
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- the oracle is what JSON keeps, and structuredClone would keep -0
        .map((sent) => JSON.parse(JSON.stringify(sent)))
        .map(({ method, params }) => ({ method, params }));
      assert.deepEqual(split.notifications, expected);
      assert.deepEqual(split.notifications, whole.notifications);
      assert.deepEqual(split.errors, whole.errors);
    })
  );
});
