import { readFileSync } from 'node:fs';

import { assert, test } from 'orca/testing';

/*
 * Structural checks on .github/workflows/release.yml, read as text because
 * tests cannot import a YAML parser. The push-to-main path itself can only be
 * exercised in real CI.
 */

const text = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
/** The workflow without its full-line comments, so prose never trips a check. */
const code = text
  .split('\n')
  .filter((line) => !/^\s*#/u.test(line))
  .join('\n');

/** Each job's text, keyed by its id, from the lines under `jobs:`. */
function splitJobs(source: string): Map<string, string> {
  const start = source.search(/^jobs:$/mu);
  assert.ok(start !== -1, 'no jobs: block');
  const jobs = new Map<string, string>();
  const headers = [...source.slice(start).matchAll(/^ {2}(?<id>[a-z-]+):$/gmu)];
  for (const [index, header] of headers.entries()) {
    const from = start + (header.index ?? 0);
    const to = index + 1 < headers.length ? start + (headers[index + 1]?.index ?? 0) : undefined;
    jobs.set(header.groups?.id ?? '', source.slice(from, to));
  }
  return jobs;
}

const jobs = splitJobs(code);
const job = (name: string): string => {
  const body = jobs.get(name);
  assert.ok(body !== undefined, `no ${name} job`);
  return body;
};

test('the workflow has the pending, quality, build, tag and publish jobs', () => {
  assert.deepEqual([...jobs.keys()], ['pending', 'quality', 'build', 'tag', 'publish']);
});

test('runs on v* tags and on every push to main', () => {
  assert.match(code, /^on:\n {2}push:\n {4}branches: \[main\]\n {4}tags:\n {6}- 'v\*'$/mu);
});

test('top-level permissions are empty', () => {
  assert.match(code, /^permissions: \{\}$/mu);
});

test('jobs that hold a write permission never install dependencies', () => {
  const writers = [...jobs].filter(([, body]) => /: write$/mu.test(body));
  assert.ok(writers.length > 0, 'no job holds a write permission');
  for (const [name, body] of writers) {
    assert.ok(!/\bnpm (?:ci|install|i)\b/u.test(body), `${name} installs dependencies`);
  }
});

test('pending and tag check nothing out', () => {
  for (const name of ['pending', 'tag']) {
    assert.ok(!/\buses:/u.test(job(name)), `${name} uses an action`);
  }
});

test('publish never runs on the push to main', () => {
  const condition = /^ {4}if: (?<condition>.+)$/mu.exec(job('publish'))?.groups?.condition ?? '';
  assert.ok(
    condition.includes("!(github.event_name == 'push' && github.ref_type == 'branch')"),
    `publish if: ${condition}`
  );
});

test('every action is pinned to a 40-character SHA', () => {
  const uses = [...text.matchAll(/^\s*(?:- )?uses: (?<ref>\S.*)$/gmu)]
    .map((match) => match.groups?.ref ?? '')
    .filter((ref) => !ref.startsWith('./'));
  assert.ok(uses.length > 0, 'no uses: lines found');
  for (const ref of uses) {
    assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/u, `unpinned: ${ref}`);
  }
});

test('nothing publishes to npm', () => {
  assert.ok(!/\bnpm publish\b/u.test(code), 'the workflow runs npm publish');
});
