import { createHash } from 'node:crypto';

/** Downloads `url` and returns the body only when its SHA-256 is `sha256`. */
async function downloadVerified(
  url: string,
  sha256: string,
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    hash.update(chunk);
    chunks.push(Buffer.from(chunk));
  }
  if (hash.digest('hex') !== sha256.toLowerCase()) {
    throw new Error(`checksum mismatch for ${url}`);
  }
  return Buffer.concat(chunks);
}

export { downloadVerified };
