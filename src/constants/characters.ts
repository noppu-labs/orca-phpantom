// UTF-16 code units the editor and the worker both look for. No imports: the editor bundle reads this too.

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

// A high surrogate and the low one after it make one character outside the Basic Multilingual Plane.
const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;
const LOW_SURROGATE_MIN = 0xdc_00;
const LOW_SURROGATE_MAX = 0xdf_ff;

export {
  CARRIAGE_RETURN,
  HIGH_SURROGATE_MAX,
  HIGH_SURROGATE_MIN,
  LINE_FEED,
  LOW_SURROGATE_MAX,
  LOW_SURROGATE_MIN,
};
