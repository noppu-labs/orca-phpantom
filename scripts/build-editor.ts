import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Adapted from actus7/orca-autocomplete editor/build.mjs @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Builds the editor into editor/dist: Orca installs a plugin as files and runs it with no network and no node_modules, so Monaco and our code ship prebuilt.
// Run `npm run build` after changing editor/src and commit the result; CI rebuilds and fails when editor/dist differs.
import { build, type BuildOptions } from 'esbuild';

import { BYTES_PER_KIB } from '../src/constants/units.ts';

const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const MAX_FILE_MIB = 10;
const MAX_FILE_BYTES = MAX_FILE_MIB * BYTES_PER_MIB;
const MAX_FILES = 200;

// Why a fixed working directory and relative paths: the output must not depend on where it is run from.
const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const dist = join(pluginDir, 'editor/dist');

rmSync(dist, { force: true, recursive: true });
const shared: BuildOptions = {
  absWorkingDir: pluginDir,
  bundle: true,
  format: 'esm',
  loader: { '.ttf': 'dataurl' },
  logLevel: 'warning',
  minify: true,
  outdir: 'editor/dist',
  target: 'es2022',
};
await build({
  ...shared,
  chunkNames: 'chunks/[name]-[hash]',
  entryPoints: { main: 'editor/src/main.ts' },
  splitting: true,
});
// Why a second build: the worker is loaded on its own and must not depend on the page's chunks.
await build({ ...shared, entryPoints: { 'editor.worker': 'editor/src/editor.worker.ts' } });

function files(dir: string): { bytes: number; path: string }[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? files(full)
      : [{ bytes: statSync(full).size, path: full.slice(dist.length + 1) }];
  });
}

const built = files(dist);
const total = built.reduce((sum, file) => sum + file.bytes, 0);
// oxlint-disable-next-line eslint/no-console -- the build script reports the bundle size to the terminal that ran it
console.log(`editor/dist: ${(total / BYTES_PER_MIB).toFixed(2)} MiB in ${built.length} files`);
const problems = [
  ...built
    .filter((file) => file.bytes > MAX_FILE_BYTES)
    .map((file) => `${file.path} is over 10 MiB (${file.bytes} bytes)`),
  ...(built.length > MAX_FILES ? [`${built.length} files, more than ${MAX_FILES}`] : []),
];
if (problems.length > 0) {
  // oxlint-disable-next-line eslint/no-console -- the build script names the files over Orca's limits before it exits 1
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
