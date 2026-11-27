// Adapted from actus7/orca-autocomplete src/lsp/servers.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

interface Environment {
  PATH?: string;
  Path?: string;
  PATHEXT?: string;
}

/** The full path of a command on PATH, or null. Windows also tries the PATHEXT extensions. */
function findExecutable(
  command: string,
  env: Environment = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync
): string | null {
  const flavour = platform === 'win32' ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? '').split(flavour.delimiter).filter(Boolean);
  // Why not the bare name on Windows: npm leaves a Unix script with no extension beside the .cmd, and Windows cannot run it. Only the PATHEXT forms (.exe, .cmd ...) are runnable there.
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((extension) => extension.toLowerCase())
      : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = flavour.join(directory, command + extension);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Folders a Dock-launched app may lack on PATH but where PHPantom is commonly installed. */
function wellKnownDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (platform === 'win32') {
    const { USERPROFILE: profile } = env;
    return profile === undefined || profile === '' ? [] : [win32.join(profile, '.cargo', 'bin')];
  }
  const { HOME: home } = env;
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(home === undefined || home === '' ? [] : [posix.join(home, '.cargo', 'bin')]),
  ];
}

/** `1.1.0` from `phpantom_lsp 1.1.0`. */
function parseVersion(output: string): string | null {
  return /^phpantom_lsp (?<version>\d+\.\d+\.\d+)\b/mu.exec(output.trim())?.groups?.version ?? null;
}

// Major, minor and patch.
const VERSION_PARTS = 3;
const VERSION_TIMEOUT_MS = 5000;

function atLeast(version: string, minimum: string): boolean {
  const versionParts = version.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  for (let index = 0; index < VERSION_PARTS; index++) {
    const part = versionParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (part !== minimumPart) {
      return part > minimumPart;
    }
  }
  return true;
}

/** Runs `<path> --version`; null when it fails, times out or prints something else. */
async function readVersion(path: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseVersion(String(stdout)));
    });
  });
}

export { findExecutable, wellKnownDirs, parseVersion, atLeast, readVersion };
