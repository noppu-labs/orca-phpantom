// Adapted from actus7/orca-autocomplete src/lsp/servers.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

type Environment = { PATH?: string; Path?: string; PATHEXT?: string };

/** The full path of a command on PATH, or null. Windows also tries the PATHEXT extensions. */
export function findExecutable(
  command: string,
  env: Environment = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync
): string | null {
  const flavour = platform === 'win32' ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? '').split(flavour.delimiter).filter(Boolean);
  // Why not the bare name on Windows: npm leaves a Unix script with no extension beside the .cmd, and
  // Windows cannot run it. Only the PATHEXT forms (.exe, .cmd ...) are runnable there.
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
export function wellKnownDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (platform === 'win32') {
    return env.USERPROFILE ? [win32.join(env.USERPROFILE, '.cargo', 'bin')] : [];
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(env.HOME ? [posix.join(env.HOME, '.cargo', 'bin')] : []),
  ];
}

/** `1.1.0` from `phpantom_lsp 1.1.0`. */
export function parseVersion(output: string): string | null {
  return /^phpantom_lsp (\d+\.\d+\.\d+)\b/m.exec(output.trim())?.[1] ?? null;
}

export function atLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return true;
}

/** Runs `<path> --version`; null when it fails, times out or prints something else. */
export async function readVersion(path: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseVersion(String(stdout)));
    });
  });
}
