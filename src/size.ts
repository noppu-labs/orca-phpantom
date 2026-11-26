// How big Orca thinks a value is. Orca does not measure a request's answer as JSON: it walks the value
// and counts 8 bytes per number, 1 per null or boolean, each string's UTF-8 bytes, 8 per array or object
// plus 4 per element or key (and the key's bytes), and it refuses more than 10,000 arrays and objects
// whatever their size (Orca 1.4 `MW`, used for `plugin.request` answers and panel posts). A list of
// locations is mostly small objects and numbers, so it hits these limits long before its JSON would.

export type Size = { bytes: number; objects: number }

export const ORCA_MAX_OBJECTS = 10_000

const encoder = new TextEncoder()

export function orcaSize(value: unknown): Size {
  const size: Size = { bytes: 0, objects: 0 }
  const walk = (item: unknown): void => {
    if (item === null || item === undefined || typeof item === 'boolean') {
      size.bytes += 1
      return
    }
    if (typeof item === 'number') {
      size.bytes += 8
      return
    }
    if (typeof item === 'string') {
      size.bytes += encoder.encode(item).byteLength
      return
    }
    if (typeof item !== 'object') {
      return
    }
    size.objects += 1
    size.bytes += Array.isArray(item) ? 8 : 0
    if (Array.isArray(item)) {
      for (const element of item) {
        size.bytes += 4
        walk(element)
      }
      return
    }
    for (const [key, entry] of Object.entries(item)) {
      size.bytes += 4 + encoder.encode(key).byteLength
      walk(entry)
    }
  }
  walk(value)
  return size
}

export const fitsIn = (size: Size, limit: Size): boolean => size.bytes <= limit.bytes && size.objects <= limit.objects

/** The leading `items` that fit in `limit` beside `envelope`, the answer measured with an empty list. */
export function leadingThatFit<T>(items: T[], envelope: Size, limit: Size): T[] {
  let bytes = envelope.bytes
  let objects = envelope.objects
  const kept: T[] = []
  for (const item of items) {
    const size = orcaSize(item)
    if (bytes + 4 + size.bytes > limit.bytes || objects + size.objects > limit.objects) {
      break
    }
    bytes += 4 + size.bytes
    objects += size.objects
    kept.push(item)
  }
  return kept
}
