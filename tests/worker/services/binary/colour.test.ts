import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, test } from 'orca/testing';

import { FULL_COLOUR_CONFIG, globalConfigPath } from '../../../../src/services/binary/colour.ts';
import type { ReleaseAsset } from '../../../../src/services/binary/release.ts';
import {
  cacheDir,
  resolveBinary,
  type ResolveOptions,
} from '../../../../src/services/binary/resolve.ts';
import { oneTarGz } from '../../../helpers/archives.ts';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'phpantom-colour-'));
}

// Only answers for files under the temp home, so a real Homebrew install on the host never leaks in.
const inHome =
  (home: string) =>
  async (path: string): Promise<string | null> =>
    path.startsWith(home) ? '1.1.0' : null;

function downloading(home: string, logs: string[]): ResolveOptions {
  const body = oneTarGz();
  const asset: ReleaseAsset = {
    asset: 'one.tar.gz',
    sha256: createHash('sha256').update(body).digest('hex'),
    member: 'phpantom_lsp',
    kind: 'tar.gz',
  };
  return {
    settingPath: '',
    allowDownload: true,
    env: { PATH: '' },
    platform: 'linux',
    arch: 'x64',
    home,
    readVersionImpl: inHome(home),
    assets: () => asset,
    fetchImpl: async () => new Response(new Uint8Array(body)),
    log: (message) => logs.push(message),
  };
}

function executable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'installed');
  chmodSync(path, 0o755);
}

test('finds the global config where PHPantom looks for it', () => {
  assert.equal(globalConfigPath({}, 'linux', '/h'), '/h/.config/phpantom_lsp/.phpantom.toml');
  assert.equal(globalConfigPath({}, 'darwin', '/h'), '/h/.config/phpantom_lsp/.phpantom.toml');
  assert.equal(
    globalConfigPath({ XDG_CONFIG_HOME: '/x' }, 'darwin', '/h'),
    '/x/phpantom_lsp/.phpantom.toml'
  );
  assert.equal(
    globalConfigPath({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h'),
    '/x/phpantom_lsp/.phpantom.toml'
  );
  // PHPantom ignores a relative or empty XDG_CONFIG_HOME.
  assert.equal(
    globalConfigPath({ XDG_CONFIG_HOME: 'rel' }, 'linux', '/h'),
    '/h/.config/phpantom_lsp/.phpantom.toml'
  );
  assert.equal(
    globalConfigPath({ XDG_CONFIG_HOME: '' }, 'linux', '/h'),
    '/h/.config/phpantom_lsp/.phpantom.toml'
  );
  assert.equal(
    globalConfigPath({ APPDATA: String.raw`C:\A` }, 'win32', String.raw`C:\u`),
    String.raw`C:\A\phpantom_lsp\.phpantom.toml`
  );
  assert.equal(
    globalConfigPath({ APPDATA: '' }, 'win32', String.raw`C:\u`),
    String.raw`C:\u\AppData\Roaming\phpantom_lsp\.phpantom.toml`
  );
  assert.equal(
    globalConfigPath({ XDG_CONFIG_HOME: String.raw`C:\x` }, 'win32', String.raw`C:\u`),
    String.raw`C:\u\AppData\Roaming\phpantom_lsp\.phpantom.toml`
  );
});

test('a download writes the full-colour global config when there is none', async () => {
  const home = temp();
  try {
    const logs: string[] = [];
    const r = await resolveBinary(downloading(home, logs));
    assert.equal(r.ok && r.source, 'download');
    const config = join(home, '.config', 'phpantom_lsp', '.phpantom.toml');
    assert.equal(readFileSync(config, 'utf8'), '[semantic-tokens]\nmode = "full"\n');
    assert.equal(FULL_COLOUR_CONFIG, '[semantic-tokens]\nmode = "full"\n');
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes(config), logs[0]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a download writes under XDG_CONFIG_HOME when it is set', async () => {
  const home = temp();
  try {
    const xdg = join(home, 'xdg');
    const r = await resolveBinary({
      ...downloading(home, []),
      env: { PATH: '', XDG_CONFIG_HOME: xdg },
    });
    assert.equal(r.ok && r.source, 'download');
    assert.equal(
      readFileSync(join(xdg, 'phpantom_lsp', '.phpantom.toml'), 'utf8'),
      FULL_COLOUR_CONFIG
    );
    assert.ok(!existsSync(join(home, '.config')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a download leaves an existing global config alone', async () => {
  const home = temp();
  try {
    const config = join(home, '.config', 'phpantom_lsp', '.phpantom.toml');
    mkdirSync(join(config, '..'), { recursive: true });
    writeFileSync(config, '[semantic-tokens]\nmode = "off"\n');
    const logs: string[] = [];
    const r = await resolveBinary(downloading(home, logs));
    assert.equal(r.ok && r.source, 'download');
    assert.equal(readFileSync(config, 'utf8'), '[semantic-tokens]\nmode = "off"\n');
    assert.deepEqual(logs, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a config that cannot be written logs a warning and still starts PHPantom', async () => {
  const home = temp();
  try {
    // A file where the config folder should be makes the write fail.
    writeFileSync(join(home, '.config'), 'not a folder');
    const logs: string[] = [];
    const r = await resolveBinary(downloading(home, logs));
    assert.equal(r.ok && r.source, 'download');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Warning: /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a PHPantom the user installed never gets a global config', async () => {
  const home = temp();
  try {
    const config = join(home, '.config', 'phpantom_lsp', '.phpantom.toml');
    const logs: string[] = [];
    const options = downloading(home, logs);

    const setting = join(home, 'custom', 'phpantom_lsp');
    executable(setting);
    const fromSetting = await resolveBinary({ ...options, settingPath: setting });
    assert.equal(fromSetting.ok && fromSetting.source, 'setting');

    const bin = join(home, 'bin');
    executable(join(bin, 'phpantom_lsp'));
    const fromPath = await resolveBinary({ ...options, env: { PATH: bin } });
    assert.equal(fromPath.ok && fromPath.source, 'path');

    executable(join(home, '.cargo', 'bin', 'phpantom_lsp'));
    const fromFolder = await resolveBinary({ ...options, env: { PATH: '', HOME: home } });
    assert.equal(fromFolder.ok && fromFolder.source, 'path');
    assert.equal(fromFolder.ok && fromFolder.path, join(home, '.cargo', 'bin', 'phpantom_lsp'));

    assert.ok(!existsSync(config));
    assert.deepEqual(logs, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a copy downloaded earlier does not write the config again', async () => {
  const home = temp();
  try {
    const dir = join(cacheDir({}, 'linux', home), '1.1.0', 'linux-x64');
    executable(join(dir, 'phpantom_lsp'));
    writeFileSync(join(dir, 'verified'), '1.1.0');
    const logs: string[] = [];
    const r = await resolveBinary(downloading(home, logs));
    assert.equal(r.ok && r.source, 'cache');
    assert.ok(!existsSync(join(home, '.config', 'phpantom_lsp', '.phpantom.toml')));
    assert.deepEqual(logs, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
