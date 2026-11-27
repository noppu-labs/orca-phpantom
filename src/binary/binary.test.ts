import { assert, test } from 'orca/testing';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified } from './download.ts';
import { extractSingleFile } from './extract.ts';
import { atLeast, findExecutable, parseVersion, readVersion, wellKnownDirs } from './find.ts';
import { assetFor, downloadUrl, type ReleaseAsset } from './release.ts';
import { cacheDir, resolveBinary, type ResolveOptions } from './resolve.ts';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function withServer(body: Buffer, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/a`);
  } finally {
    server.close();
  }
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'phpantom-binary-'));
}

function base(home: string): ResolveOptions {
  return {
    settingPath: '',
    allowDownload: false,
    env: { PATH: '' },
    platform: 'linux',
    arch: 'x64',
    home,
  };
}

test('maps all six platforms and nothing else', () => {
  assert.equal(assetFor('darwin', 'arm64')?.asset, 'phpantom_lsp-aarch64-apple-darwin.tar.gz');
  assert.equal(
    assetFor('win32', 'x64')?.sha256,
    '9b5b93400171881517a36dc34ac330db733399a6faaec7e88eec18d3189d11bd'
  );
  assert.equal(assetFor('linux', 'ia32'), null);
  assert.equal(assetFor('linux', 'toString'), null);
  assert.equal(
    downloadUrl(assetFor('linux', 'x64')!),
    'https://github.com/PHPantom-dev/phpantom_lsp/releases/download/1.1.0/phpantom_lsp-x86_64-unknown-linux-gnu.tar.gz'
  );
});
test('extracts the one file from each archive kind', () => {
  assert.equal(
    extractSingleFile(readFileSync(fixture('one.tar.gz')), 'tar.gz', 'phpantom_lsp').toString(),
    'fake-binary'
  );
  assert.equal(
    extractSingleFile(readFileSync(fixture('one.zip')), 'zip', 'phpantom_lsp.exe').toString(),
    'fake-exe'
  );
  assert.throws(
    () => extractSingleFile(readFileSync(fixture('one.zip')), 'zip', 'other'),
    /archive has no other/
  );
  assert.throws(
    () => extractSingleFile(readFileSync(fixture('one.tar.gz')), 'tar.gz', 'other'),
    /archive has no other/
  );
});
test('reads and compares versions', () => {
  assert.equal(parseVersion('phpantom_lsp 1.1.0\n'), '1.1.0');
  assert.equal(parseVersion('something else'), null);
  assert.ok(atLeast('1.1.0', '1.1.0') && atLeast('1.10.0', '1.9.9') && !atLeast('1.0.9', '1.1.0'));
});
test('finds executables and well-known folders', () => {
  assert.equal(
    findExecutable('x', { PATH: '/a:/b' }, 'linux', (p) => p === '/b/x'),
    '/b/x'
  );
  assert.equal(
    findExecutable('x', { PATH: 'C:\\a', PATHEXT: '.EXE' }, 'win32', (p) => p === 'C:\\a\\x.exe'),
    'C:\\a\\x.exe'
  );
  assert.deepEqual(wellKnownDirs({ HOME: '/h' }, 'darwin'), [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/h/.cargo/bin',
  ]);
  assert.deepEqual(wellKnownDirs({ USERPROFILE: 'C:\\u' }, 'win32'), ['C:\\u\\.cargo\\bin']);
});
test('places the cache per platform', () => {
  assert.equal(cacheDir({}, 'darwin', '/h'), '/h/Library/Caches/noppu-labs.phpantom');
  assert.equal(cacheDir({}, 'linux', '/h'), '/h/.cache/noppu-labs.phpantom');
  assert.equal(cacheDir({ XDG_CACHE_HOME: '/x' }, 'linux', '/h'), '/x/noppu-labs.phpantom');
  assert.equal(
    cacheDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\u'),
    'C:\\L\\noppu-labs.phpantom\\cache'
  );
});
test('readVersion runs the binary and returns null for a missing one', async () => {
  const dir = temp();
  try {
    const script = join(dir, 'phpantom_lsp');
    writeFileSync(script, '#!/bin/sh\necho "phpantom_lsp 1.2.3"\n');
    chmodSync(script, 0o755);
    if (process.platform !== 'win32') {
      assert.equal(await readVersion(script), '1.2.3');
    }
    assert.equal(await readVersion(join(dir, 'missing')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('rejects a download whose hash differs', async () => {
  await withServer(Buffer.from('tampered'), async (url) => {
    await assert.rejects(downloadVerified(url, '0'.repeat(64)), /checksum mismatch/);
  });
});
test('accepts a download whose hash matches', async () => {
  const body = Buffer.from('payload');
  await withServer(body, async (url) => {
    const got = await downloadVerified(url, createHash('sha256').update(body).digest('hex'));
    assert.equal(got.toString(), 'payload');
  });
});
test('reports an HTTP error', async () => {
  const fetchImpl = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    downloadVerified('http://x/y', '0'.repeat(64), fetchImpl),
    /download failed: HTTP 404/
  );
});
test('an explicit setting that does not work is an error, not a fallback', async () => {
  const home = temp();
  try {
    const r = await resolveBinary({ ...base(home), settingPath: '/nope/phpantom_lsp' });
    assert.deepEqual(r, {
      ok: false,
      message: 'phpantomPath is set to /nope/phpantom_lsp, which is not a working phpantom_lsp.',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Only answers for files under the temp home, so a real Homebrew install on the host never leaks in.
const inHome =
  (home: string) =>
  async (path: string): Promise<string | null> =>
    path.startsWith(home) ? '1.1.0' : null;

const tarball = (): { asset: ReleaseAsset; body: Buffer } => {
  const body = readFileSync(fixture('one.tar.gz'));
  return {
    body,
    asset: {
      asset: 'one.tar.gz',
      sha256: createHash('sha256').update(body).digest('hex'),
      member: 'phpantom_lsp',
      kind: 'tar.gz',
    },
  };
};

test('skips an old PATH binary, downloads when allowed, then uses the cache', async () => {
  const home = temp();
  const bin = temp();
  try {
    const old = join(bin, 'phpantom_lsp');
    writeFileSync(old, 'old');
    chmodSync(old, 0o755);
    const { asset, body } = tarball();
    const readVersionImpl = async (path: string): Promise<string | null> =>
      path === old ? '1.0.0' : inHome(home)(path);
    let fetched = 0;
    let announced = 0;
    const fetchImpl = (async () => {
      fetched++;
      return new Response(new Uint8Array(body));
    }) as unknown as typeof fetch;
    const options: ResolveOptions = {
      ...base(home),
      env: { PATH: bin },
      allowDownload: true,
      readVersionImpl,
      assets: () => asset,
      fetchImpl,
      onDownload: () => {
        announced++;
      },
    };
    const first = await resolveBinary(options);
    assert.equal(first.ok && first.source, 'download');
    assert.equal(fetched, 1);
    assert.equal(announced, 1);
    if (first.ok) {
      assert.equal(readFileSync(first.path).toString(), 'fake-binary');
      assert.ok(existsSync(join(first.path, '..', 'verified')));
      assert.ok(!existsSync(`${first.path}.tmp`));
    }
    const second = await resolveBinary({
      ...options,
      fetchImpl: (async () => {
        throw new Error('no network');
      }) as unknown as typeof fetch,
    });
    assert.equal(second.ok && second.source, 'cache');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
test('shares one download between concurrent resolves', async () => {
  const home = temp();
  try {
    const { asset, body } = tarball();
    let fetched = 0;
    const options: ResolveOptions = {
      ...base(home),
      allowDownload: true,
      readVersionImpl: inHome(home),
      assets: () => asset,
      fetchImpl: (async () => {
        fetched++;
        return new Response(new Uint8Array(body));
      }) as unknown as typeof fetch,
    };
    const [a, b] = await Promise.all([resolveBinary(options), resolveBinary(options)]);
    assert.ok(a.ok && b.ok);
    assert.equal(fetched, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('a cache entry without the verified marker is not trusted', async () => {
  const home = temp();
  try {
    const dir = join(cacheDir({}, 'linux', home), '1.1.0', 'linux-x64');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'phpantom_lsp'), 'unverified');
    const r = await resolveBinary({ ...base(home), readVersionImpl: inHome(home) });
    assert.equal(r.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('says how to install when downloads are off', async () => {
  const home = temp();
  try {
    const r = await resolveBinary({ ...base(home), readVersionImpl: async () => null });
    assert.deepEqual(r, {
      ok: false,
      message:
        'PHPantom 1.1.0 or newer was not found. Install it (brew install phpantom-lsp) or turn on "Download PHPantom when missing".',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('an unsupported platform has no build', async () => {
  const home = temp();
  try {
    const r = await resolveBinary({
      ...base(home),
      arch: 'ia32',
      readVersionImpl: async () => null,
    });
    assert.deepEqual(r, { ok: false, message: 'PHPantom has no build for linux-ia32.' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('a failed checksum leaves nothing in the cache', async () => {
  const home = temp();
  try {
    const { asset } = tarball();
    const r = await resolveBinary({
      ...base(home),
      allowDownload: true,
      readVersionImpl: inHome(home),
      assets: () => ({ ...asset, sha256: '0'.repeat(64) }),
      fetchImpl: (async () => new Response('tampered')) as unknown as typeof fetch,
    });
    assert.equal(r.ok, false);
    assert.ok(!existsSync(join(cacheDir({}, 'linux', home), '1.1.0')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Real download from GitHub. Opt in with PHPANTOM_INTEGRATION=1.
if (process.env.PHPANTOM_INTEGRATION === '1') {
  test('downloads, verifies and runs the real release', async () => {
    const home = temp();
    try {
      const r = await resolveBinary({
        settingPath: '',
        allowDownload: true,
        env: { PATH: '' },
        platform: process.platform,
        arch: process.arch,
        home,
        // The real PATH-less run must not pick up Homebrew's copy.
        readVersionImpl: (path) =>
          path.startsWith(home) ? readVersion(path) : Promise.resolve(null),
      });
      assert.ok(r.ok, r.ok ? '' : r.message);
      if (r.ok) {
        assert.equal(r.source, 'download');
        assert.equal(await readVersion(r.path), '1.1.0');
        console.log(`integration: source=${r.source} version=${r.version} path=${r.path}`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
