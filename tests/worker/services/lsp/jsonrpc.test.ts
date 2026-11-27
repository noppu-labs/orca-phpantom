// Adapted from actus7/orca-autocomplete src/lsp/jsonrpc.test.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import { assert, test } from 'orca/testing';

import { RpcConnection } from '../../../../src/services/lsp/jsonrpc.ts';

const frame = (message: object): Buffer => {
  const body = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

function connect() {
  const sent: string[] = [];
  const notifications: { method: string; params: unknown }[] = [];
  const connection = new RpcConnection((out) => sent.push(out), {
    onRequest: (method) => (method === 'workspace/configuration' ? [null] : undefined),
    onNotification: (method, params) => void notifications.push({ method, params }),
  });
  return { connection, sent, notifications };
}

test('a request resolves with the matching response', async () => {
  const { connection, sent } = connect();
  const answer = connection.request('textDocument/hover', { a: 1 });
  assert.match(
    sent[0],
    /^Content-Length: \d+\r\n\r\n\{"jsonrpc":"2.0","id":1,"method":"textDocument\/hover"/
  );
  connection.feed(frame({ jsonrpc: '2.0', id: 1, result: { contents: 'x' } }));
  assert.deepEqual(await answer, { contents: 'x' });
});

test('an error response rejects with its message', async () => {
  const { connection } = connect();
  const answer = connection.request('x', {});
  connection.feed(
    frame({ jsonrpc: '2.0', id: 1, error: { code: -32_601, message: 'no such method' } })
  );
  await assert.rejects(answer, /no such method/);
});

test('messages split across chunks, and several in one chunk, are all delivered', () => {
  const { connection, notifications } = connect();
  const both = Buffer.concat([
    frame({ jsonrpc: '2.0', method: 'a', params: 1 }),
    frame({ jsonrpc: '2.0', method: 'b', params: 2 }),
  ]);
  connection.feed(both.subarray(0, 10));
  connection.feed(both.subarray(10, 40));
  connection.feed(both.subarray(40));
  assert.deepEqual(
    notifications.map((n) => n.method),
    ['a', 'b']
  );
});

test('multi-byte text is measured in bytes, not characters', () => {
  const { connection, notifications } = connect();
  connection.feed(frame({ jsonrpc: '2.0', method: 'm', params: 'café \u{1F600}' }));
  assert.equal(notifications[0].params, 'café \u{1F600}');
});

test('a request from the server is answered with the handler result', async () => {
  const { connection, sent } = connect();
  connection.feed(frame({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(sent[0], /"id":7,"result":\[null\]/);
});

test('closing fails every waiting request instead of hanging', async () => {
  const { connection } = connect();
  const waiting = connection.request('x', {});
  connection.close('gone');
  await assert.rejects(waiting, /gone/);
  await assert.rejects(connection.request('y', {}), /not running/);
});

test('junk before a header is skipped', () => {
  const { connection, notifications } = connect();
  connection.feed(Buffer.from('garbage\r\n\r\n'));
  connection.feed(frame({ jsonrpc: '2.0', method: 'ok', params: null }));
  assert.deepEqual(
    notifications.map((n) => n.method),
    ['ok']
  );
});

test('cancelling a request sends $/cancelRequest and rejects', async () => {
  const { connection, sent } = connect();
  const controller = new AbortController();
  const answer = connection.request('textDocument/hover', {}, controller.signal);
  controller.abort();
  await assert.rejects(answer, /cancelled/);
  assert.match(sent[1], /"method":"\$\/cancelRequest","params":\{"id":1\}/);
  // The server may still answer; that answer is dropped without error.
  connection.feed(frame({ jsonrpc: '2.0', id: 1, result: 'late' }));
});

test('an already aborted signal rejects without sending', async () => {
  const { connection, sent } = connect();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(connection.request('x', {}, controller.signal), /cancelled/);
  assert.equal(sent.length, 0);
});

test('an answered request ignores a later abort', async () => {
  const { connection, sent } = connect();
  const controller = new AbortController();
  const answer = connection.request('x', {}, controller.signal);
  connection.feed(frame({ jsonrpc: '2.0', id: 1, result: 1 }));
  assert.equal(await answer, 1);
  controller.abort();
  assert.equal(sent.length, 1);
});

test('a notification handler that throws is reported, and the next message in the chunk still arrives', () => {
  const errors: string[] = [];
  const seen: string[] = [];
  const connection = new RpcConnection(() => undefined, {
    onRequest: () => null,
    onNotification: (method, params) => {
      if (params === null) throw new TypeError(`cannot read ${method}`);
      seen.push(method);
    },
    onError: (message) => void errors.push(message),
  });
  const chunk = Buffer.concat([
    frame({ jsonrpc: '2.0', method: 'bad', params: null }),
    frame({ jsonrpc: '2.0', method: 'good', params: {} }),
  ]);
  connection.feed(chunk);
  assert.deepEqual(seen, ['good']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bad.*cannot read bad/);
});

test('frames keep the envelope key order on the wire', async () => {
  const sent: string[] = [];
  const connection = new RpcConnection((out) => sent.push(out), {
    onRequest: (method) => {
      if (method === 'fail') throw new Error('nope');
      return { ok: true };
    },
    onNotification: () => undefined,
  });
  const body = (index: number): string => sent[index].slice(sent[index].indexOf('\r\n\r\n') + 4);

  void connection.request('m', { a: 1 });
  connection.notify('n', null);
  connection.feed(frame({ jsonrpc: '2.0', id: 7, method: 'ask', params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  connection.feed(frame({ jsonrpc: '2.0', id: 8, method: 'fail', params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(body(0), '{"jsonrpc":"2.0","id":1,"method":"m","params":{"a":1}}');
  assert.equal(body(1), '{"jsonrpc":"2.0","method":"n","params":null}');
  assert.equal(body(2), '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}');
  assert.equal(body(3), '{"jsonrpc":"2.0","id":8,"error":{"code":-32603,"message":"nope"}}');
});
