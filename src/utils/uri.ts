// Adapted from actus7/orca-autocomplete src/lsp/uri.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Language servers spell the same file differently: `file:///E:/a/b.ts`, `file:///e%3A/a/b.ts`,
// `file:///E%3a/a/B.ts`. A file is the same file whichever way it is written, so compare by a key.

/** A spelling-independent key for a `file:` URI. Paths on a Windows drive ignore case, as the drive does. */
function uriKey(uri: string): string {
  let path = uri.replace(/^file:\/\//iu, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // Why keep going: a malformed escape still compares equal to the same malformed text.
  }
  path = path.split('\\').join('/');
  return /^\/[A-Za-z]:/u.test(path) ? path.toLowerCase() : path;
}

const sameUri = (a: string, b: string): boolean => uriKey(a) === uriKey(b);

/** Whether `uri` names a file on disk, by its `file:` scheme in any case. */
const isFileUri = (uri: string): boolean => /^file:/iu.test(uri);

export { isFileUri, uriKey, sameUri };
