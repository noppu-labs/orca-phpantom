// A tiny language server for tests, plain JavaScript with its own framing so `node` runs it directly.
// FAKE_CONFIG_ITEMS=n: after `initialized`, asks for n configuration items and logs the answer as a warning.
// Hover answers `len=<text length>`; `fake/text` answers the whole text it holds; completion answers 5000 items of about 400 bytes each;
// references answer 6000 small locations (over Orca's object limit); formatting answers one 1.2 MB edit; semanticTokens/full answers 40,000 tokens (200,000 numbers).
// FAKE_NULL_PARAMS=1: after `initialized`, sends publishDiagnostics, $/progress and window/logMessage with `params: null`.
// FAKE_MODE=silent: never answers initialize. FAKE_MODE=stubborn: answers, then ignores shutdown, exit, stdin end.
// Both ignore SIGTERM, so only SIGKILL removes them.
const mode = process.env.FAKE_MODE ?? '';
if (mode) {
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
}
let buffer = Buffer.alloc(0);
let text = '';
let uri = '';

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function offsetAt(position) {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + position.character;
}

function publish() {
  const diagnostics = [];
  for (const match of text.matchAll(/BAD/g)) {
    diagnostics.push({
      range: {
        start: { line: 0, character: match.index },
        end: { line: 0, character: match.index + 3 },
      },
      message: 'bad',
      severity: 1,
    });
  }
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
  if (text.includes('CRASH')) {
    process.stderr.write('fake server crashed on purpose\n');
    process.exit(3);
  }
}

function handle(message) {
  const { id, method, params } = message;
  if (mode === 'silent' || (mode === 'stubborn' && (method === 'shutdown' || method === 'exit'))) {
    return;
  }
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        capabilities: {
          textDocumentSync: 2,
          hoverProvider: true,
          definitionProvider: true,
          semanticTokensProvider: {
            legend: { tokenTypes: ['parameter'], tokenModifiers: [] },
            full: true,
          },
        },
      },
    });
  } else if (method === 'initialized') {
    send({
      jsonrpc: '2.0',
      id: 9001,
      method: 'window/workDoneProgress/create',
      params: { token: 'index' },
    });
    send({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'begin', title: 'Indexing', percentage: 0 } },
    });
    send({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'report', percentage: 50 } },
    });
    send({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'end' } },
    });
    send({ jsonrpc: '2.0', id: 9002, method: 'workspace/inlayHint/refresh', params: null });
    if (process.env.FAKE_NULL_PARAMS) {
      for (const method of ['textDocument/publishDiagnostics', '$/progress', 'window/logMessage']) {
        send({ jsonrpc: '2.0', method, params: null });
      }
    }
    const items = Number(process.env.FAKE_CONFIG_ITEMS ?? 0);
    if (items > 0) {
      send({
        jsonrpc: '2.0',
        id: 9003,
        method: 'workspace/configuration',
        params: { items: Array.from({ length: items }, () => ({ section: 'x' })) },
      });
    }
  } else if (id === 9003) {
    send({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { type: 2, message: `config=${JSON.stringify(message.result)}` },
    });
  } else if (method === 'textDocument/didOpen') {
    uri = params.textDocument.uri;
    text = params.textDocument.text;
    publish();
  } else if (method === 'textDocument/didChange') {
    for (const change of params.contentChanges) {
      text = change.range
        ? text.slice(0, offsetAt(change.range.start)) +
          change.text +
          text.slice(offsetAt(change.range.end))
        : change.text;
    }
    publish();
  } else if (method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id,
      result: { contents: { kind: 'markdown', value: `len=${text.length}` } },
    });
  } else if (method === 'fake/text') {
    send({ jsonrpc: '2.0', id, result: text });
  } else if (method === 'textDocument/completion') {
    const items = Array.from({ length: 5000 }, (_, i) => ({
      label: `item${i}`,
      detail: 'x'.repeat(400),
    }));
    send({ jsonrpc: '2.0', id, result: { isIncomplete: false, items } });
  } else if (method === 'textDocument/references') {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } };
    send({
      jsonrpc: '2.0',
      id,
      result: Array.from({ length: 6000 }, (_, i) => ({ uri: `file:///w/F${i}.php`, range })),
    });
  } else if (method === 'textDocument/formatting') {
    send({
      jsonrpc: '2.0',
      id,
      result: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          newText: 'x'.repeat(1200 * 1024),
        },
      ],
    });
  } else if (method === 'textDocument/semanticTokens/full') {
    send({
      jsonrpc: '2.0',
      id,
      result: { resultId: 'r1', data: Array.from({ length: 200_000 }, (_, i) => i % 5) },
    });
  } else if (method === 'shutdown') {
    send({ jsonrpc: '2.0', id, result: null });
  } else if (method === 'exit') {
    process.exit(0);
  } else if (id !== undefined && method !== undefined) {
    send({ jsonrpc: '2.0', id, result: null });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) {
      return;
    }
    const length = Number(
      /content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))[1]
    );
    if (buffer.length < end + 4 + length) {
      return;
    }
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});
if (!mode) {
  process.stdin.on('end', () => process.exit(0));
}
