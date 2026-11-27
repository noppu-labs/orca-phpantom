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
  return posix.join(env.XDG_CACHE_HOME || posix.join(home, '.cache'), 'noppu-labs.phpantom');
}

interface ResolveOptions {
  settingPath: string;
  allowDownload: boolean;
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  home: string;
  onDownload?(): void;
  log?(message: string): void;
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
    return version
      ? { ok: true, path: options.settingPath, version, source: 'setting' }
      : {
          ok: false,
          message: `phpantomPath is set to ${options.settingPath}, which is not a working phpantom_lsp.`,
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
    if (!candidate) {
      continue;
    }
    const version = await read(candidate);
    if (version && atLeast(version, PHPANTOM_VERSION)) {
      return { ok: true, path: candidate, version, source: 'path' };
    }
  }

  const asset = (options.assets ?? assetFor)(options.platform, options.arch);
  if (!asset) {
    return { ok: false, message: `PHPantom has no build for ${options.platform}-${options.arch}.` };
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
    if (version) {
      return { ok: true, path: target, version, source: 'cache' };
    }
  }

  if (!options.allowDownload) {
    return {
      ok: false,
      message:
        'PHPantom 1.1.0 or newer was not found. Install it (brew install phpantom-lsp) or turn on "Download PHPantom when missing".',
    };
  }
  let pending = inFlight.get(target);
  if (!pending) {
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
    if (!version) {
      return { ok: false, message: `The downloaded ${asset.member} did not run.` };
    }
    // Why only here: a PHPantom the user installed may serve other editors, so its config stays theirs.
    writeFullColourDefault(options.env, options.platform, options.home, options.log ?? (() => {}));
    return { ok: true, path: target, version, source: 'download' };
  } catch (error) {
    return {
      ok: false,
      message: `Could not download PHPantom: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export { cacheDir, resolveBinary };
export type { Resolution, ResolveOptions };
