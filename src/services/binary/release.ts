const PHPANTOM_VERSION = '1.1.0';

interface ReleaseAsset {
  asset: string;
  sha256: string;
  member: 'phpantom_lsp' | 'phpantom_lsp.exe';
  kind: 'tar.gz' | 'zip';
}

const tar = (asset: string, sha256: string): ReleaseAsset => ({
  asset,
  sha256,
  member: 'phpantom_lsp',
  kind: 'tar.gz',
});
const zip = (asset: string, sha256: string): ReleaseAsset => ({
  asset,
  sha256,
  member: 'phpantom_lsp.exe',
  kind: 'zip',
});

const ASSETS: Record<string, ReleaseAsset> = {
  'darwin-arm64': tar(
    'phpantom_lsp-aarch64-apple-darwin.tar.gz',
    '7ce64bbb0aea4e421cbc055f1b5b0cde36eaeb0ccb14da235f136447d29c6b70'
  ),
  'darwin-x64': tar(
    'phpantom_lsp-x86_64-apple-darwin.tar.gz',
    '6f66e490f41b2d013b3aba0abe60d5909af1a83f10417dc253a0dfbaebab7866'
  ),
  'linux-arm64': tar(
    'phpantom_lsp-aarch64-unknown-linux-gnu.tar.gz',
    '888633fd40b9af4709338af7cc76a34e9096f4259812cd24911109af1d068c5f'
  ),
  'linux-x64': tar(
    'phpantom_lsp-x86_64-unknown-linux-gnu.tar.gz',
    'f374e72ebd51d5e991bb0e7e395ec3a49b3dc75f101e69e4743f908515e9d7e7'
  ),
  'win32-arm64': zip(
    'phpantom_lsp-aarch64-pc-windows-msvc.zip',
    'd6c1b8fedca8cb01f8128f863ed5eed2abd2b8b6f00c537ab518ef74c59ace73'
  ),
  'win32-x64': zip(
    'phpantom_lsp-x86_64-pc-windows-msvc.zip',
    '9b5b93400171881517a36dc34ac330db733399a6faaec7e88eec18d3189d11bd'
  ),
};

/** The pinned release asset for a `process.platform` and `process.arch`, or null when there is no build. */
function assetFor(platform: string, arch: string): ReleaseAsset | null {
  return Object.hasOwn(ASSETS, `${platform}-${arch}`) ? ASSETS[`${platform}-${arch}`] : null;
}

function downloadUrl(asset: ReleaseAsset): string {
  return `https://github.com/PHPantom-dev/phpantom_lsp/releases/download/${PHPANTOM_VERSION}/${asset.asset}`;
}

export { PHPANTOM_VERSION, assetFor, downloadUrl };
export type { ReleaseAsset };
