import { mkdirSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const FULL_COLOUR_CONFIG = '[semantic-tokens]\nmode = "full"\n';

/** Where PHPantom reads its global `.phpantom.toml`, by the same rules as its `etcetera` base strategy. */
export function globalConfigPath(env: NodeJS.ProcessEnv, platform: string, home: string): string {
  if (platform === 'win32') {
    return win32.join(
      env.APPDATA || win32.join(home, 'AppData', 'Roaming'),
      'phpantom_lsp',
      '.phpantom.toml'
    );
  }
  const xdg = env.XDG_CONFIG_HOME;
  return posix.join(
    xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, '.config'),
    'phpantom_lsp',
    '.phpantom.toml'
  );
}

/** Writes the full-colour global config unless one is already there. Never throws. */
export function writeFullColourDefault(
  env: NodeJS.ProcessEnv,
  platform: string,
  home: string,
  log: (message: string) => void
): void {
  const path = globalConfigPath(env, platform, home);
  try {
    mkdirSync((platform === 'win32' ? win32 : posix).dirname(path), { recursive: true });
    // Why `wx`: it refuses to replace a file, even one created a moment ago by someone else.
    writeFileSync(path, FULL_COLOUR_CONFIG, { flag: 'wx' });
    log(
      `Wrote ${path} to turn on full colouring, because the plugin downloaded PHPantom and there was no global PHPantom config`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return;
    }
    log(
      `Warning: could not write ${path} for full colouring: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
