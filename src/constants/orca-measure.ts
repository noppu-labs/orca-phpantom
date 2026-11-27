// What Orca adds when it measures a value (see src/utils/size.ts). No imports: the editor bundle reads this too.

/** A number, whatever its value. */
const ORCA_NUMBER_BYTES = 8;
/** An array itself, before its elements. */
const ORCA_ARRAY_BYTES = 8;
/** Each array element, and each object key beside the key's own bytes. */
const ORCA_SLOT_BYTES = 4;

export { ORCA_ARRAY_BYTES, ORCA_NUMBER_BYTES, ORCA_SLOT_BYTES };
