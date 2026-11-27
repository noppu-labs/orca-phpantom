import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Adapted from actus7/orca-autocomplete editor/build.mjs @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Builds the editor into editor/dist: Orca installs a plugin as files and runs it with no network and no node_modules, so Monaco and our code ship prebuilt.
// Run `npm run build` after
import { build } from 'esbuild';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

// Why a fixed working directory and relative paths: the output must not depend on where it is run from.
const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const dist = join(pluginDir, 'editor/dist');

rmSync(dist, { force: true, recursive: true });
const shared = {
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

function files(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? files(full)
      : [{ bytes: statSync(full).size, path: full.slice(dist.length + 1) }];
  });
}

const built = files(dist);
const total = built.reduce((sum, file) => sum + file.bytes, 0);
console.log(`editor/dist: ${(total / 1024 / 1024).toFixed(2)} MiB in ${built.length} files`);
const problems = [
  ...built
    .filter((file) => file.bytes > MAX_FILE_BYTES)
    .map((file) => `${file.path} is over 10 MiB (${file.bytes} bytes)`),
  ...(built.length > MAX_FILES ? [`${built.length} files, more than ${MAX_FILES}`] : []),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
