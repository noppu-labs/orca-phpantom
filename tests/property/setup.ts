// Every property file imports fast-check from here, so one setting covers them all.
// Normal runs keep fast-check's default run count per property.
// FC_NUM_RUNS turns the same property tests into a fuzzing pass, and `npm run fuzz` sets it (https://fast-check.dev/docs/advanced/fuzzing/).
import fc from 'fast-check';

const numRuns = Number(process.env.FC_NUM_RUNS);

if (Number.isInteger(numRuns) && numRuns > 0) {
  fc.configureGlobal({ numRuns });
}

/** One UTF-16 code unit, lone surrogates included, weighted toward the units text handling cares about. */
const codeUnit = fc.oneof(
  fc.nat({ max: 0xff_ff }).map((code) => String.fromCodePoint(code)),
  fc.integer({ min: 0xd8_00, max: 0xdf_ff }).map((code) => String.fromCodePoint(code)),
  fc.constantFrom('\n', '\r', '"', '\\', '%', '/', ':'),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })
);

/** Any string of UTF-16 code units, which `fc.string({ unit: 'binary' })` is not: that never yields a lone surrogate. */
const anyText = (constraints: { maxLength?: number; minLength?: number } = {}) =>
  fc.string({ ...constraints, unit: codeUnit });

export { anyText };
export { default as fc } from 'fast-check';
