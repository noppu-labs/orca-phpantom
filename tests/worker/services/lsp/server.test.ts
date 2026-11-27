import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assert, test } from 'orca/testing';

import { CLIENT_CAPABILITIES } from '../../../../src/services/lsp/capabilities.ts';
import {
  PhpantomServer,
  type RefreshKind,
  type ServerEvents,
} from '../../../../src/services/lsp/server.ts';
import type { ServerState } from '../../../../src/services/status.ts';

const FAKE = fileURLToPath(new URL('../../../fixtures/fake-server.mjs', import.meta.url));

interface Recorded {
  diagnostics: { uri: string; diagnostics: unknown[] }[];
  progress: ServerState[];
  refresh: RefreshKind[];
  logs: string[];
  exits: string[];
}

function fakeServer(env: Record<string, string> = {}) {
  const events: Recorded = { diagnostics: [], progress: [], refresh: [], logs: [], exits: [] };
  const hooks: ServerEvents = {
    diagnostics: (uri, diagnostics) => void events.diagnostics.push({ uri, diagnostics }),
    progress: (state) => void events.progress.push(state),
    refresh: (kind) => void events.refresh.push(kind),
    log: (message) => void events.logs.push(message),
    exit: (reason) => void events.exits.push(reason),
  };
  const children: ChildProcess[] = [];
  const spawnImpl = ((_executable: string, _args: string[], options: object) => {
    const child = spawn(process.execPath, [FAKE], {
      ...options,
      env: { ...process.env, ...env },
    } as never);
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  const server = new PhpantomServer({
    executable: 'phpantom_lsp',
    root: process.cwd(),
    events: hooks,
    spawnImpl,
    initializeTimeoutMs: 5000,
  });
  return { server, events, children };
}

async function until(condition: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const open = (text: string) => ({
  textDocument: { uri: 'file:///w/a.php', languageId: 'php', version: 1, text },
});

test('starts, initializes and reports capabilities', async () => {
  const { server, children } = fakeServer();
  await server.start();
  assert.equal((server.capabilities as any).hoverProvider, true);
  assert.equal(server.alive, true);
  await server.stop();
  assert.equal(server.alive, false);
  assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
});

test('forwards diagnostics, progress and refresh', async () => {
  const { server, events } = fakeServer();
  await server.start();
  server.notify('textDocument/didOpen', open('<?php BAD'));
  await until(
    () =>
      events.diagnostics.length > 0 &&
      events.refresh.includes('inlayHints') &&
      events.progress.at(-1)?.phase === 'ready'
  );
  assert.equal(events.diagnostics[0].diagnostics.length, 1);
  assert.ok(events.progress.some((s) => s.phase === 'indexing' && s.percent === 50));
  await server.stop();
});

test('applies incremental changes and answers requests', async () => {
  const { server } = fakeServer();
  await server.start();
  server.notify('textDocument/didOpen', open('<?php abc'));
  server.notify('textDocument/didChange', {
    textDocument: { uri: 'file:///w/a.php', version: 2 },
    contentChanges: [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, text: 'wxyz' },
    ],
  });
  const hover = (await server.request('textDocument/hover', {})) as { contents: { value: string } };
  assert.equal(hover.contents.value, 'len=10');
  await server.stop();
});

test('a request can be cancelled', async () => {
  const { server } = fakeServer();
  await server.start();
  const controller = new AbortController();
  const pending = server.request('textDocument/hover', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await server.stop();
});

test('answers configuration with one null per item', async () => {
  const { server, events } = fakeServer({ FAKE_CONFIG_ITEMS: '3' });
  await server.start();
  await until(() => events.logs.length > 0);
  assert.equal(events.logs[0], 'config=[null,null,null]');
  await server.stop();
});

test('a notification with null params is logged, and the connection keeps working', async () => {
  const { server, events } = fakeServer({ FAKE_NULL_PARAMS: '1' });
  await server.start();
  server.notify('textDocument/didOpen', open('<?php abc'));
  const hover = (await server.request('textDocument/hover', {})) as { contents: { value: string } };
  assert.equal(hover.contents.value, 'len=9');
  assert.ok(
    events.logs.some((line) => line.includes('textDocument/publishDiagnostics')),
    events.logs.join('\n')
  );
  assert.equal(server.alive, true);
  await server.stop();
});

test('capabilities that are not an object are taken as none', async () => {
  for (const capabilities of ['true', '[1]', '"x"']) {
    const { server } = fakeServer({ FAKE_CAPABILITIES: capabilities });
    await server.start();
    assert.deepEqual(server.capabilities, {});
    await server.stop();
  }
});

test('reports an exit with the stderr tail', async () => {
  const { server, events } = fakeServer();
  await server.start();
  server.notify('textDocument/didOpen', open('<?php CRASH'));
  await until(() => events.exits.length > 0);
  assert.equal(events.exits.length, 1);
  assert.match(events.exits[0], /code 3.*fake server crashed on purpose/);
  assert.equal(server.alive, false);
  await assert.rejects(server.request('textDocument/hover', {}), /not running/);
  await server.stop();
  assert.equal(events.exits.length, 1);
});

test('a deliberate stop does not report an exit', async () => {
  const { server, events } = fakeServer();
  await server.start();
  await server.stop();
  assert.deepEqual(events.exits, []);
});

test('a start that times out kills the child and reports no exit', async () => {
  const { server, events, children } = fakeServer({ FAKE_MODE: 'silent' });
  (server as any).options.initializeTimeoutMs = 200;
  await assert.rejects(server.start(), /in time/);
  assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
  assert.equal(server.alive, false);
  assert.deepEqual(events.exits, []);
});

test('stop escalates to SIGKILL when the child ignores shutdown and SIGTERM', async () => {
  const { server, events, children } = fakeServer({ FAKE_MODE: 'stubborn' });
  await server.start();
  await server.stop();
  assert.equal(children[0].signalCode, 'SIGKILL');
  assert.deepEqual(events.exits, []);
});

test('a missing executable rejects start', async () => {
  const events: ServerEvents = {
    diagnostics() {},
    progress() {},
    refresh() {},
    log() {},
    exit() {},
  };
  const server = new PhpantomServer({
    executable: '/nonexistent/phpantom_lsp',
    root: process.cwd(),
    events,
    initializeTimeoutMs: 2000,
  });
  await assert.rejects(server.start());
  assert.equal(server.alive, false);
});

test('client capabilities never ask for pull diagnostics', () => {
  assert.equal((CLIENT_CAPABILITIES.textDocument as any).diagnostic, undefined);
  assert.deepEqual((CLIENT_CAPABILITIES.textDocument.semanticTokens as any).tokenTypes.length, 15);
  assert.deepEqual(
    (CLIENT_CAPABILITIES.textDocument.semanticTokens as any).tokenModifiers.length,
    7
  );
});
