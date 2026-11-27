import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assert, test } from 'orca/testing';

const MiB = 1024 * 1024;
const root = fileURLToPath(new URL('..', import.meta.url));

interface Tracked {
  mode: string;
  path: string;
}

/** Tracked files as `git ls-files -s -z` reports them: what Orca installs from the tagged commit. */
function listTracked(): Tracked[] {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { mode: entry.slice(0, entry.indexOf(' ')), path: entry.slice(tab + 1) };
    });
}

const tracked = listTracked();
const paths = tracked.map((file) => file.path);
const read = (path: string): string => readFileSync(new URL(path, `file://${root}`), 'utf8');
const sizeOf = (path: string): number => statSync(root + path).size;
const json = (path: string): { version: string; main?: string; contributes?: any } =>
  JSON.parse(read(path));

test('the plugin folder stays inside Orca install limits', () => {
  assert.ok(paths.length <= 2000, `${paths.length} tracked files, limit 2000`);
  const total = paths.reduce((sum, path) => sum + sizeOf(path), 0);
  assert.ok(total <= 50 * MiB, `${total} bytes tracked, limit ${50 * MiB}`);
});

const BANNED_EXTENSIONS = new Set(
  (
    '.zip .tar .gz .tgz .bz2 .xz .zst .7z .rar .jar .war .apk .deb .rpm .dmg .iso ' +
    '.node .so .dylib .dll .exe .bin .wasm .pyc .pyo .class .o .a .lib .ttf .otf'
  ).split(' ')
);

const MAGIC: [string, number, number[]][] = [
  ['gzip', 0, [0x1f, 0x8b]],
  ['zip', 0, [0x50, 0x4b, 0x03, 0x04]],
  ['zip', 0, [0x50, 0x4b, 0x05, 0x06]],
  ['ELF', 0, [0x7f, 0x45, 0x4c, 0x46]],
  ['Mach-O', 0, [0xfe, 0xed, 0xfa, 0xce]],
  ['Mach-O', 0, [0xfe, 0xed, 0xfa, 0xcf]],
  ['Mach-O', 0, [0xce, 0xfa, 0xed, 0xfe]],
  ['Mach-O', 0, [0xcf, 0xfa, 0xed, 0xfe]],
  ['Mach-O', 0, [0xca, 0xfe, 0xba, 0xbe]],
  ['PE', 0, [0x4d, 0x5a]],
  ['wasm', 0, [0x00, 0x61, 0x73, 0x6d]],
  ['7z', 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['rar', 0, [0x52, 0x61, 0x72, 0x21]],
  ['xz', 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ['bzip2', 0, [0x42, 0x5a, 0x68]],
  ['tar', 257, [0x75, 0x73, 0x74, 0x61, 0x72]],
  ['sfnt font', 0, [0x00, 0x01, 0x00, 0x00]],
  ['OpenType font', 0, [0x4f, 0x54, 0x54, 0x4f]],
];

function head(path: string): Buffer {
  const buffer = Buffer.alloc(262);
  const fd = openSync(root + path, 'r');
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
}

function refusal({ mode, path }: Tracked): string | undefined {
  if (mode === '120000') return 'symlink';
  if (mode === '100755') return 'executable bit';
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  if (BANNED_EXTENSIONS.has(extension)) return `${extension} extension`;
  if (!existsSync(root + path)) return undefined;
  const bytes = head(path);
  const hit = MAGIC.find(([, offset, magic]) =>
    magic.every((byte, index) => bytes[offset + index] === byte)
  );
  return hit ? `${hit[0]} magic number` : undefined;
}

test('no tracked file is one the Orca plugin indexer refuses', () => {
  const refused = tracked.flatMap((file) => {
    const reason = refusal(file);
    return reason ? [`${file.path}: ${reason}`] : [];
  });
  assert.deepEqual(refused, [], `refused by the indexer:\n${refused.join('\n')}`);
});

test('every path the manifest names exists', () => {
  const manifest = json('orca-plugin.json');
  assert.equal(manifest.main, 'src/main.ts');
  const entries: string[] = manifest.contributes.customEditors.map(
    (editor: { entry: string }) => editor.entry
  );
  assert.ok(entries.length > 0, 'no custom editor entries');
  for (const path of [manifest.main, ...entries]) {
    assert.ok(existsSync(root + path), `${path} is missing`);
    assert.ok(paths.includes(path), `${path} is not tracked`);
  }
});

test('editor entries and the files they load stay under 10 MiB, transpiled sources under 1 MiB', () => {
  const under = (prefixes: string[]) =>
    paths.filter((path) => prefixes.some((prefix) => path.startsWith(prefix)));
  for (const path of under(['editor/pages/', 'editor/dist/'])) {
    assert.ok(sizeOf(path) <= 10 * MiB, `${path} is over 10 MiB`);
  }
  for (const path of under(['src/', 'editor/src/']).filter((p) => /\.m?ts$/.test(p))) {
    assert.ok(sizeOf(path) <= MiB, `${path} is over 1 MiB`);
  }
});

test('orca-plugin.json and package.json carry the same version', () => {
  const { version } = json('orca-plugin.json');
  assert.equal(version, json('package.json').version);
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
