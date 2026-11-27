// Reading JSON nobody typed: a language server's answers, Orca's payloads, errors thrown by others.

/** A JSON object: not null and not an array, so its fields can be read by name. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether an `if` takes `value` as true: anything but `undefined`, `null`, `false`, `0`, `0n`, `''` and `NaN`.
 * For a server's answers and capabilities, which may be any JSON value, so `false`, `0` and `''` say "not there" as `null` does.
 */
function isTruthy(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    value !== 0 &&
    value !== 0n &&
    value !== '' &&
    !Number.isNaN(value)
  );
}

export { isRecord, isTruthy };
