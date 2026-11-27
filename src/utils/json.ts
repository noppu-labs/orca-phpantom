// Reading JSON nobody typed: a language server's answers, Orca's payloads, errors thrown by others.

/** A JSON object: not null and not an array, so its fields can be read by name. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { isRecord };
