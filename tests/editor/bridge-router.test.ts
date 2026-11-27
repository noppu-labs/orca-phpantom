import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bridge against the real router (and the fake language server), not against a scripted host: the
// Two halves of the protocol have to agree on chunks, versions, lengths, resyncs and sessions.
import { afterEach, assert, test } from 'orca/testing';

import { LspBridge, type BridgeHost } from '../../editor/src/bridge.ts';
import { Router, type RouterHost } from '../../src/controllers/router.ts';
import { PhpantomServer } from '../../src/services/lsp/server.ts';
import { ORCA_MAX_OBJECTS, orcaSize } from '../../src/utils/size.ts';
import { source } from '../helpers/fake-source.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-server.mjs', import.meta.url));
const spawnFake = ((_executable: string, _args: string[], options: object) =>
  spawn(process.execPath, [FAKE], options as never)) as unknown as typeof spawn;
const FAST = {
  syncDelayMs: 5,
  retryGapMs: 30,
  quietMs: 10,
  saveDelayMs: 25,
  reattachGapMs: 0,
  mountWindowMs: 80,
  settleMs: 60,
};
// Lines enough for a frame with unsaved edits to be placed by likeness.
const SAVED = '<?php\nclass A {\n  function f() {}\n}\n';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  ms = 4000
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(5);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A worker (a Router) behind frames' hosts. `restart` puts a new Router, with a new session, in its place. */
function harness(options: { leaseMs?: number; sweepMs?: number } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'phpantom-bridge-router-')));
  mkdirSync(join(dir, 'a'));
  writeFileSync(join(dir, 'a/composer.json'), '{}');
  writeFileSync(join(dir, 'a/A.php'), SAVED);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const listeners = new Map<string, Set<(payload: any) => void>>();
  const servers: PhpantomServer[] = [];
  /** Requests Orca would refuse: a panel message over 64 KiB or 10,000 objects by its own measure. */
  const oversized: string[] = [];
  const routerHost: RouterHost = {
    listWorkspaces: async () => [
      { id: 'ws-a', name: 'a', branch: 'main', path: join(dir, 'a'), hostId: 'local' },
    ],
    openEditor: async () => undefined,
    // Every frame of the editor hears every post.
    post: (event, payload) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    status: () => undefined,
    log: () => undefined,
    settings: async () => ({ phpantomPath: '', allowDownload: false }),
  };
  const makeRouter = (): Router => {
    const router = new Router(routerHost, {
      resolve: async () => ({ ok: true, path: 'phpantom_lsp', version: '1.1.0', source: 'path' }),
      createServer: (executable, root, events) => {
        const server = new PhpantomServer({
          executable,
          root,
          events,
          spawnImpl: spawnFake,
          initializeTimeoutMs: 5000,
        });
        servers.push(server);
        return server;
      },
      ...options,
    });
    cleanups.push(() => router.dispose());
    return router;
  };
  let router = makeRouter();

  /** One editor frame's host. A dead frame (Orca replaced it) sends nothing more, close included. */
  const frame = (panel: string) => {
    let dead = false;
    const none = { dispose: () => undefined };
    const host: BridgeHost = {
      async request(name, input): Promise<any> {
        if (dead) return new Promise(() => undefined);
        // The whole panel message, as Orca measures it: a session token of up to 128 bytes, the action, the request.
        const size = orcaSize({
          sessionToken: 'x'.repeat(128),
          action: 'plugin.request',
          params: { name, input },
        });
        if (size.bytes > 64 * 1024 || size.objects > ORCA_MAX_OBJECTS)
          oversized.push(`${name}: ${JSON.stringify(size)}`);
        const current = router;
        const typed = input as any;
        switch (name) {
          case 'phpantom.open':
            return current.open(typed, { panel });
          case 'phpantom.change':
            return current.change(typed);
          case 'phpantom.request':
            return current.request(typed, new AbortController().signal);
          case 'phpantom.close':
            return current.close(typed);
          case 'phpantom.navigate':
            return current.navigate(typed);
          case 'phpantom.peek':
            return current.peek(typed);
          case 'phpantom.ping':
            return current.ping(typed);
          default:
            throw new Error(`unknown request ${String(name)}`);
        }
      },
      on(event, handler) {
        const set = listeners.get(event) ?? new Set();
        listeners.set(event, set);
        set.add(handler);
        return { dispose: () => void set.delete(handler) };
      },
      readContext: async () => ({ workspaceId: 'ws-a', branch: 'main', displayName: 'a' }),
      onWorkspaceChanged: () => none,
      onFirstInput: () => none,
      onVisible: () => none,
      onSaved: () => none,
      onSettingsChanged: () => none,
    };
    return { host, die: () => void (dead = true) };
  };

  return {
    get router() {
      return router;
    },
    servers,
    oversized,
    frame,
    /** The worker restarted: a new Router, with a new session, that knows no document. */
    async restart(): Promise<void> {
      const old = router;
      router = makeRouter();
      await old.dispose();
    },
    /** What the newest PHPantom holds, asked of it directly. */
    holds: async (): Promise<string> => (await servers.at(-1)!.request('fake/text', {})) as string,
  };
}

test('integration: a paste over 64 KiB reaches PHPantom split into groups, and a resync after it', async () => {
  const world = harness();
  const doc = source(SAVED);
  const { host } = world.frame('panel-1');
  const bridge = new LspBridge(host, doc, FAST);
  cleanups.push(() => bridge.dispose());
  assert.equal((await bridge.attach()).state, 'ready');
  // Two cursors, each pasting about 70 KB: one event whose changes must be split across requests.
  doc.editMany([
    [6, 6, 'é😀"\\\n'.repeat(10_000)],
    [16, 16, 'abc\n'.repeat(18_000)],
  ]);
  await until(async () => (await world.holds()) === doc.text, 'PHPantom to hold the pasted text');
  // A whole-text replace goes as a resync; typing after it goes on as changes.
  doc.replaceAll(`${SAVED}// replaced\n`);
  doc.edit(0, 0, '// top\n');
  await until(async () => (await world.holds()) === doc.text, 'PHPantom to hold the resynced text');
  assert.equal(
    await bridge
      .ask('textDocument/hover', { position: { line: 0, character: 0 } })
      .then((answer: any) => answer?.contents?.value),
    `len=${doc.text.length}`
  );
  assert.deepEqual(world.oversized, []);
});

test('integration: after the worker restarts, the next request re-attaches under the new session', async () => {
  const world = harness();
  const doc = source(SAVED);
  const bridge = new LspBridge(world.frame('panel-1').host, doc, FAST);
  cleanups.push(() => bridge.dispose());
  const first = await bridge.attach();
  assert.equal(first.state, 'ready');
  const sessions: string[] = [];
  bridge.onReady((status) => sessions.push(status.session));
  await world.restart();
  // The edit is what finds out: the new worker answers it detached, and the bridge opens the document again.
  doc.edit(0, 0, '// after the restart\n');
  await until(() => sessions.length === 1, 'a re-attach');
  assert.equal(
    await bridge
      .ask('textDocument/hover', { position: { line: 0, character: 0 } })
      .then((answer: any) => answer?.contents?.value),
    `len=${doc.text.length}`
  );
  assert.deepEqual(sessions, [world.router.session]);
  assert.notEqual(sessions[0], (first as { session: string }).session);
  assert.equal(world.servers.length, 2);
  assert.equal(await world.holds(), doc.text);
});

test('integration: three frames of one tab, two of them dead, keep PHPantom on the live one', async () => {
  // Orca mounts a new frame on every tab show; the old ones go quiet without a close and hold the file until their lease ends.
  const world = harness({ leaseMs: 400, sweepMs: 20 });
  const one = world.frame('panel-1');
  const b1 = new LspBridge(one.host, source(SAVED), { ...FAST, pingMs: 50 });
  cleanups.push(() => b1.dispose());
  assert.equal((await b1.attach()).state, 'ready');
  one.die();
  await wait(200);

  const two = world.frame('panel-1');
  const d2 = source(SAVED);
  const b2 = new LspBridge(two.host, d2, { ...FAST, pingMs: 50 });
  cleanups.push(() => b2.dispose());
  assert.equal((await b2.attach()).state, 'ready');
  d2.edit(0, 0, 'X');
  await until(async () => (await world.holds()) === d2.text, "the second frame's edit");
  two.die();

  const three = world.frame('panel-1');
  const d3 = source(d2.text);
  const b3 = new LspBridge(three.host, d3, { ...FAST, pingMs: 50 });
  cleanups.push(() => b3.dispose());
  assert.equal((await b3.attach()).state, 'ready');
  d3.edit(0, 0, 'Y');
  await until(async () => (await world.holds()) === d3.text, "the third frame's edit");
  assert.match(world.router.describe(), /3 open document\(s\)/);

  // The first dead frame's lease ends while the second still holds the file.
  await until(
    () => /2 open document\(s\)/.test(world.router.describe()),
    'the first frame to be released'
  );
  assert.equal(await world.holds(), d3.text);
  // Whatever PHPantom holds, the live frame's question is asked of its own text.
  assert.equal(await b3.ask('fake/text', {}), d3.text);
  await until(
    () => /1 open document\(s\)/.test(world.router.describe()),
    'the second frame to be released'
  );
  assert.equal(await world.holds(), d3.text);
  assert.deepEqual(world.oversized, []);
});
