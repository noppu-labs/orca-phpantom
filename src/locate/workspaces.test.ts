import { assert, test } from 'orca/testing';
import { join } from 'node:path';
import {
  composerRoot,
  isLocal,
  resolveFocused,
  workspaceFor,
  type WorkspaceRow,
} from './workspaces.ts';

const row = (
  id: string,
  name: string,
  branch: string | null,
  path: string,
  hostId: string | null = 'local'
): WorkspaceRow => ({
  id,
  name,
  branch,
  path,
  hostId,
});

test('maps the focused workspace by id, then by branch and name', () => {
  const rows = [row('a', 'app', 'main', '/w/a'), row('b', 'app2', 'feat', '/w/b')];
  assert.equal(resolveFocused(rows, 'b'), rows[1]);
  assert.equal(resolveFocused(rows, 'zzz', { branch: 'main', displayName: 'app' }), rows[0]);
  assert.equal(resolveFocused(rows, null, { branch: 'feat', displayName: 'app2' }), rows[1]);
  assert.equal(resolveFocused(rows, 'zzz'), null);
  assert.equal(resolveFocused(rows, null, { branch: 'nope', displayName: 'app' }), null);
});

test('the branch and name fallback is used only when exactly one row matches', () => {
  const rows = [
    row('a', 'main', 'main', '/w/a'),
    row('b', 'main', 'main', '/w/b'),
    row('c', 'x', 'dev', '/w/c'),
  ];
  assert.equal(resolveFocused(rows, 'zzz', { branch: 'main', displayName: 'main' }), null);
  assert.equal(resolveFocused(rows, 'a', { branch: 'main', displayName: 'main' }), rows[0]);
});

test('remote and WSL workspaces are not local', () => {
  assert.equal(
    isLocal({ id: '1', name: 'x', branch: null, path: '/srv/app', hostId: 'ssh:box' }),
    false
  );
  assert.equal(
    isLocal({
      id: '2',
      name: 'x',
      branch: null,
      path: '\\\\wsl.localhost\\Ubuntu\\app',
      hostId: 'local',
    }),
    false
  );
  assert.equal(
    isLocal({ id: '4', name: 'x', branch: null, path: '\\\\WSL$\\Ubuntu\\app', hostId: null }),
    false
  );
  assert.equal(
    isLocal({
      id: '5',
      name: 'x',
      branch: null,
      path: '//wsl.localhost/Ubuntu/app',
      hostId: 'local',
    }),
    false
  );
  assert.equal(
    isLocal({ id: '3', name: 'x', branch: null, path: '/Users/me/app', hostId: null }),
    true
  );
  assert.equal(
    isLocal({ id: '6', name: 'x', branch: null, path: '/Users/me/app', hostId: 'local' }),
    true
  );
});

test('the composer root is the nearest composer.json inside the workspace', () => {
  const ws = '/w/app';
  const has = new Set([join(ws, 'composer.json'), join(ws, 'packages/api/composer.json')]);
  const exists = (p: string) => has.has(p);
  assert.equal(
    composerRoot(join(ws, 'packages/api/src/A.php'), ws, exists),
    join(ws, 'packages/api')
  );
  assert.equal(composerRoot(join(ws, 'app/B.php'), ws, exists), ws);
  assert.equal(
    composerRoot(join(ws, 'app/B.php'), ws, () => false),
    ws
  );
  // never climbs above the workspace
  assert.equal(
    composerRoot(join(ws, 'app/B.php'), ws, (p) => p === '/w/composer.json'),
    ws
  );
});

test('the workspace for a file is the local row with the longest containing path', () => {
  const rows = [
    row('a', 'a', null, '/w/app'),
    row('b', 'b', null, '/w/app/nested'),
    row('c', 'c', null, '/w/app/nested/deeper', 'ssh:box'),
    row('d', 'd', null, '/w/application'),
  ];
  assert.equal(workspaceFor('/w/app/nested/x.php', rows), rows[1]);
  assert.equal(workspaceFor('/w/app/nested/deeper/x.php', rows), rows[1]);
  assert.equal(workspaceFor('/w/application/x.php', rows), rows[3]);
  assert.equal(workspaceFor('/elsewhere/x.php', rows), null);
});

test('a file inside a Composer vendor folder belongs to the project that holds the vendor folder', () => {
  const ws = join('/w', 'proj');
  const a = join(ws, 'a');
  const files = new Set([join(a, 'composer.json'), join(a, 'vendor/x/y/composer.json')]);
  const exists = (p: string) => files.has(p);
  assert.equal(composerRoot(join(a, 'vendor/x/y/src/Z.php'), ws, exists), a);
  assert.equal(composerRoot(join(a, 'vendor/x/y/Z.php'), ws, exists), a);
  // A folder named vendor with no composer.json beside it is an ordinary folder.
  assert.equal(
    composerRoot(
      join(ws, 'b/vendor/x/y/src/Z.php'),
      ws,
      (p) => p === join(ws, 'b/vendor/x/y/composer.json')
    ),
    join(ws, 'b/vendor/x/y')
  );
  // A vendor folder at the workspace root.
  assert.equal(
    composerRoot(
      join(ws, 'vendor/laravel/framework/src/A.php'),
      ws,
      (p) =>
        p === join(ws, 'composer.json') || p === join(ws, 'vendor/laravel/framework/composer.json')
    ),
    ws
  );
});
