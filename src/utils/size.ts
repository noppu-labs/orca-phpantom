// How big Orca thinks a value is. Orca does not measure a payload as JSON: it walks the value and counts
// 8 bytes per number, 1 per null, undefined or boolean, each string's UTF-8 bytes, and for an array 8 plus
// 4 per element, for an object 4 per key plus the key's UTF-8 bytes (nothing is added for the object itself).
// It refuses a value with more than 10,000 arrays and objects, or nested deeper than 100, whatever its size
// (`structuredCloneMessageBytes` in plugin-panel-message-budget.js, and `MW` in the main bundle, which
// Measures `plugin.request` answers (1 MiB), worker posts (256 KiB, payload only) and panel requests
// (64 KiB, the whole `{ sessionToken, action, params }` message)). A list of locations is mostly small
// Objects and numbers, so it hits these limits long before its JSON would. Depth is not tracked here:
// Nothing the plugin sends nests anywhere near 100.

export type Size = { bytes: number; objects: number };

export const ORCA_MAX_OBJECTS = 10_000;

const encoder = new TextEncoder();

export function orcaSize(value: unknown): Size {
  const size: Size = { bytes: 0, objects: 0 };
  const walk = (item: unknown): void => {
    if (item === null || item === undefined || typeof item === 'boolean') {
      size.bytes += 1;
      return;
    }
    if (typeof item === 'number') {
      size.bytes += 8;
      return;
    }
    if (typeof item === 'string') {
      size.bytes += encoder.encode(item).byteLength;
      return;
    }
    if (typeof item !== 'object') {
      return;
    }
    size.objects += 1;
    size.bytes += Array.isArray(item) ? 8 : 0;
    if (Array.isArray(item)) {
      for (const element of item) {
        size.bytes += 4;
        walk(element);
      }
      return;
    }
    for (const [key, entry] of Object.entries(item)) {
      size.bytes += 4 + encoder.encode(key).byteLength;
      walk(entry);
    }
  };
  walk(value);
  return size;
}

export const fitsIn = (size: Size, limit: Size): boolean =>
  size.bytes <= limit.bytes && size.objects <= limit.objects;

/** The leading `items` that fit in `limit` beside `envelope`, the answer measured with an empty list. */
export function leadingThatFit<T>(items: T[], envelope: Size, limit: Size): T[] {
  let { bytes } = envelope;
  let { objects } = envelope;
  const kept: T[] = [];
  for (const item of items) {
    const size = orcaSize(item);
    if (bytes + 4 + size.bytes > limit.bytes || objects + size.objects > limit.objects) {
      break;
    }
    bytes += 4 + size.bytes;
    objects += size.objects;
    kept.push(item);
  }
  return kept;
}
