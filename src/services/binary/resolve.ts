import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

import { writeFullColourDefault } from './colour.ts';
import { downloadVerified } from './download.ts';
import { extractSingleFile } from './extract.ts';
import { atLeast, findExecutable, readVersion, wellKnownDirs } from './find.ts';
import { assetFor, downloadUrl, PHPANTOM_VERSION, type ReleaseAsset } from './release.ts';

type Resolution =
  | { ok: true; path: string; version: string; source: 'setting' | 'path' | 'cache' | 'download' }
  | { ok: false; message: string };

function cacheDir(env: NodeJS.ProcessEnv, platform: string, home: string): string {
  if (platform === 'win32') {
    return win32.join(
      env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'),
      'noppu-labs.phpantom',
      'cache'
    );
  }
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Caches', 'noppu-labs.phpantom');
  }
  const { XDG_CACHE_HOME: xdg } = env;
  return posix.join(
    xdg === undefined || xdg === '' ? posix.join(home, '.cache') : xdg,
    'noppu-labs.phpantom'
  );
}

interface ResolveOptions {
  settingPath: string;
  allowDownload: boolean;
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  home: string;
  onDownload?: () => void;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  readVersionImpl?: typeof readVersion;
  /** Test seam: where the release assets come from. */
  assets?: (platform: string, arch: string) => ReleaseAsset | null;
}

const inFlight = new Map<string, Promise<Resolution>>();

async function resolveBinary(options: ResolveOptions): Promise<Resolution> {
  const read = options.readVersionImpl ?? readVersion;
  const flavour = options.platform === 'win32' ? win32 : posix;

  if (options.settingPath) {
    const version = existsSync(options.settingPath) ? await read(options.settingPath) : null;
    return version !== null && version !== ''
      ? { ok: true, path: options.settingPath, source: 'setting', version }
      : {
          message: `phpantomPath is set to ${options.settingPath}, which is not a working phpantom_lsp.`,
          ok: false,
        };
  }

  const candidates = [
    findExecutable('phpantom_lsp', options.env, options.platform),
    ...wellKnownDirs(options.env, options.platform).map((directory) =>
      findExecutable(
        'phpantom_lsp',
        { PATH: directory, PATHEXT: options.env.PATHEXT },
        options.platform
      )
    ),
  ];
  for (const candidate of new Set(candidates)) {
    if (candidate === null || candidate === '') {
      continue;
    }
    const version = await read(candidate);
    if (version !== null && version !== '' && atLeast(version, PHPANTOM_VERSION)) {
      return { ok: true, path: candidate, source: 'path', version };
    }
  }

  const asset = (options.assets ?? assetFor)(options.platform, options.arch);
  if (!asset) {
    return { message: `PHPantom has no build for ${options.platform}-${options.arch}.`, ok: false };
  }
  const directory = flavour.join(
    cacheDir(options.env, options.platform, options.home),
    PHPANTOM_VERSION,
    `${options.platform}-${options.arch}`
  );
  const target = flavour.join(directory, asset.member);
  const marker = flavour.join(directory, 'verified');
  if (existsSync(target) && existsSync(marker)) {
    const version = await read(target);
    if (version !== null && version !== '') {
      return { ok: true, path: target, source: 'cache', version };
    }
  }

  if (!options.allowDownload) {
    return {
      message:
        'PHPantom 1.1.0 or newer was not found. Install it (brew install phpantom-lsp) or turn on "Download PHPantom when missing".',
      ok: false,
    };
  }
  let pending = inFlight.get(target);
  if (pending === undefined) {
    pending = download(options, asset, directory, target, marker, read).finally(() =>
      inFlight.delete(target)
    );
    inFlight.set(target, pending);
  }
  return pending;
}

async function download(
  options: ResolveOptions,
  asset: ReleaseAsset,
  directory: string,
  target: string,
  marker: string,
  read: typeof readVersion
): Promise<Resolution> {
  try {
    options.onDownload?.();
    const archive = await downloadVerified(downloadUrl(asset), asset.sha256, options.fetchImpl);
    const binary = extractSingleFile(archive, asset.kind, asset.member);
    mkdirSync(directory, { recursive: true });
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, binary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
    writeFileSync(marker, PHPANTOM_VERSION);
    const version = await read(target);
    if (version === null || version === '') {
      return { message: `The downloaded ${asset.member} did not run.`, ok: false };
    }
    // Why only here: a PHPantom the user installed may serve other editors, so its config stays theirs.
    writeFullColourDefault(options.env, options.platform, options.home, options.log ?? (() => {}));
    return { ok: true, path: target, source: 'download', version };
  } catch (error) {
    return {
      message: `Could not download PHPantom: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
}

export { cacheDir, resolveBinary };
export type { Resolution, ResolveOptions };
