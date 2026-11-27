// Adapted from actus7/orca-autocomplete src/lsp/locate.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// A custom editor never learns its file's path, but a language server needs one.
// The open document equals the file on disk, so find it: look through the workspaces for a file of the right type
//
// A document with unsaved edits equals no file.
// Then the file it was opened from is the one that still shares most of its lines, as long as one file is clearly ahead of the rest.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import type { Language } from '../../protocol.ts';

export type Located =
  | { status: 'found'; path: string; root: string; approximate?: true }
  | { status: 'none' }
  | { status: 'ambiguous' };

// Folders full of generated or foreign files: never the file being edited, and slow to walk.
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'venv',
  '__pycache__',
  'Pods',
  'AppData',
]);
// Skipped only beside a composer.json: Composer's vendor folder and Laravel's storage. Published views
// (resources/views/vendor) and lang/vendor hold files people edit.
const COMPOSER_SIBLING_SKIPPED = new Set(['vendor', 'storage']);
const MAX_FILES_VISITED = 80_000;
const BUDGET_MS = 3000;
const BOM_BYTES = 3;

// The search by likeness: how alike a file must be, how far ahead of the next one, and how much is read.
const ALIKE_MIN = 0.6;
const ALIKE_LEAD = 0.15;
const ALIKE_MIN_LINES = 3;
const ALIKE_MAX_FILES = 300;
const ALIKE_MAX_BYTES = 1_000_000;
const ALIKE_BUDGET_MS = 1500;
/** A file this many times bigger or smaller than the document cannot share enough lines with it. */
const ALIKE_SIZE_RATIO = 3;

interface Options {
  maxFiles?: number;
  budgetMs?: number;
  alikeBudgetMs?: number;
}

/** The extensions a php document can have: .php and the ones Drupal uses for PHP. */
export const PHP_EXTENSIONS: readonly string[] = [
  '.php',
  '.module',
  '.install',
  '.theme',
  '.profile',
  '.inc',
  '.engine',
];

/** A blade document matches only names ending .blade.php; a php document a longer name ending in a PHP extension, other than .blade.php. */
function nameMatches(name: string, language: Language): boolean {
  const lower = name.toLowerCase();
  if (language === 'blade') {
    return lower.endsWith('.blade.php');
  }
  return (
    !lower.endsWith('.blade.php') &&
    PHP_EXTENSIONS.some((extension) => lower.endsWith(extension) && lower.length > extension.length)
  );
}

/** The lines that say something: trimmed, without the empty ones. */
function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * How much two texts share, by whole lines: 1 for the same lines, 0 for none in common. A line that
 * appears twice counts twice, so a file of repeated braces does not look like every other file.
 */
export function sharedLines(a: string, b: string): number {
  const linesA = meaningfulLines(a);
  const linesB = meaningfulLines(b);
  if (linesA.length < ALIKE_MIN_LINES || linesB.length < ALIKE_MIN_LINES) {
    return 0;
  }
  const left = new Map<string, number>();
  for (const line of linesB) {
    left.set(line, (left.get(line) ?? 0) + 1);
  }
  let shared = 0;
  for (const line of linesA) {
    const count = left.get(line) ?? 0;
    if (count > 0) {
      shared += 1;
      left.set(line, count - 1);
    }
  }
  return shared / Math.max(linesA.length, linesB.length);
}

interface Candidate {
  path: string;
  root: string;
  size: number;
}

/** The one file that is clearly the document with a few edits on top, if there is such a file. */
async function locateAlike(
  candidates: Candidate[],
  content: string,
  size: number,
  budgetMs: number
): Promise<Located> {
  if (size > ALIKE_MAX_BYTES) {
    return { status: 'none' };
  }
  const deadline = Date.now() + budgetMs;
  const near = candidates
    .filter(
      (file) =>
        file.size <= ALIKE_MAX_BYTES &&
        file.size * ALIKE_SIZE_RATIO >= size &&
        file.size <= size * ALIKE_SIZE_RATIO
    )
    // Why nearest in size first: a few edits barely change the size, so the right file is read early.
    .sort((a, b) => Math.abs(a.size - size) - Math.abs(b.size - size))
    .slice(0, ALIKE_MAX_FILES);
  let best: { file: Candidate; score: number } | null = null;
  let second = 0;
  for (const file of near) {
    if (Date.now() > deadline) {
      break;
    }
    const text = await readFile(file.path, 'utf8').catch(() => null);
    if (text === null) {
      continue;
    }
    const score = sharedLines(content, text);
    if (!best || score > best.score) {
      second = best?.score ?? 0;
      best = { file, score };
    } else if (score > second) {
      second = score;
    }
  }
  if (!best || best.score < ALIKE_MIN) {
    return { status: 'none' };
  }
  if (best.score - second < ALIKE_LEAD) {
    return { status: 'ambiguous' };
  }
  return { status: 'found', path: best.file.path, root: best.file.root, approximate: true };
}

export interface LocateInput {
  tiers: string[][];
  candidates: string[];
  /** Files located before (open now or not long ago), which the walk may not reach: Composer's vendor folder. */
  known?: string[];
  language: Language;
  content: string;
}

/** The workspace path among the tiers that holds the file, the longest when they nest; empty when none does. */
function rootOf(path: string, tiers: readonly (readonly string[])[]): string {
  let best = '';
  for (const root of tiers.flat()) {
    const prefix = root.endsWith(sep) || root.endsWith('/') ? root : root + sep;
    if ((path.startsWith(prefix) || path.startsWith(`${root}/`)) && root.length > best.length) {
      best = root;
    }
  }
  return best;
}

/** Pending reveal paths first: the file the person is navigating to is the one this document is. */
async function locateCandidates(input: LocateInput, options: Options): Promise<Located> {
  const size = Buffer.byteLength(input.content, 'utf8');
  const matches: string[] = [];
  const others: Candidate[] = [];
  for (const path of new Set(input.candidates)) {
    const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
    if (!nameMatches(name, input.language)) {
      continue;
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      continue;
    }
    const text = (await readFile(path, 'utf8').catch(() => null))?.replace(/^﻿/, '');
    if (text === input.content) {
      matches.push(path);
    } else {
      others.push({ path, root: rootOf(path, input.tiers), size: info.size });
    }
  }
  if (matches.length === 1) {
    return { status: 'found', path: matches[0], root: rootOf(matches[0], input.tiers) };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous' };
  }
  return locateAlike(others, input.content, size, options.alikeBudgetMs ?? ALIKE_BUDGET_MS);
}

export async function locateFile(input: LocateInput, options: Options = {}): Promise<Located> {
  const fromCandidates = await locateCandidates(input, options);
  if (fromCandidates.status !== 'none') {
    return fromCandidates;
  }
  const remembered = knownRelatives(input.known ?? [], input.tiers);
  for (const tier of input.tiers) {
    // Why still walk: an identical copy the walk can see (a duplicated file) makes the answer ambiguous.
    const known = await locateKnown(tier, remembered, input.language, input.content);
    const found = await locateInRoots(tier, input.language, input.content, options, known);
    if (found.status !== 'none') {
      return found;
    }
  }
  return { status: 'none' };
}

/** Each known path relative to the workspace holding it, so the same file can be looked for in every worktree. */
function knownRelatives(known: readonly string[], tiers: readonly (readonly string[])[]): string[] {
  const relatives = new Set<string>();
  for (const path of known) {
    const root = rootOf(path, tiers);
    if (root) {
      relatives.add(path.slice(root.length).replace(/^[\\/]+/, ''));
    }
  }
  return [...relatives];
}

/**
 * Known files placed under this tier's workspaces, by exact text only. Why under every workspace: a file
 * remembered in a sibling worktree has a copy here, and the focused worktree's copy must win.
 */
async function locateKnown(
  roots: readonly string[],
  relatives: readonly string[],
  language: Language,
  content: string
): Promise<{ path: string; root: string }[]> {
  if (relatives.length === 0) {
    return [];
  }
  const size = Buffer.byteLength(content, 'utf8');
  const matches: { path: string; root: string }[] = [];
  for (const root of roots) {
    for (const relative of relatives) {
      const path = join(root, relative);
      if (
        !nameMatches(
          path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1),
          language
        )
      ) {
        continue;
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || (info.size !== size && info.size !== size + BOM_BYTES)) {
        continue;
      }
      const text = (await readFile(path, 'utf8').catch(() => null))?.replace(/^\uFEFF/, '');
      if (text === content) {
        matches.push({ path, root });
      }
    }
  }
  return matches;
}

async function locateInRoots(
  roots: readonly string[],
  language: Language,
  content: string,
  options: Options,
  /** Exact matches found already (remembered files the walk may not reach). */
  known: readonly { path: string; root: string }[] = []
): Promise<Located> {
  const size = Buffer.byteLength(content, 'utf8');
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS);
  let visited = 0;
  const matches: { path: string; root: string }[] = [...known];
  const others: Candidate[] = [];

  // Why breadth-first: the file being edited is nearly always close to the workspace root, so a huge tree (a home folder used as a workspace) must not use up the time before the shallow files are seen.
  const queue = roots.map((root) => ({ root, directory: root }));
  for (let next = 0; next < queue.length; next += 1) {
    // Why here: a deadline or cap checked only inside the entry loop would still read every queued directory.
    if (Date.now() > deadline || visited >= (options.maxFiles ?? MAX_FILES_VISITED)) {
      break;
    }
    const { root, directory } = queue[next];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    // The cap counts directories read plus name-matching files seen, so it bounds directory I/O too.
    visited += 1;
    const hasComposer = entries.some((entry) => entry.name === 'composer.json');
    for (const entry of entries) {
      if (Date.now() > deadline || visited > (options.maxFiles ?? MAX_FILES_VISITED)) {
        break;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          !SKIPPED_DIRECTORIES.has(entry.name) &&
          !entry.name.startsWith('.') &&
          !(hasComposer && COMPOSER_SIBLING_SKIPPED.has(entry.name))
        ) {
          queue.push({ root, directory: path });
        }
      } else if (entry.isFile() && nameMatches(entry.name, language)) {
        visited += 1;
        // Why stat first: reading every file of a large repository would take far too long.
        const info = await stat(path).catch(() => null);
        if (!info) {
          continue;
        }
        let same = false;
        if (info.size === size || info.size === size + BOM_BYTES) {
          const text = (await readFile(path, 'utf8').catch(() => null))?.replace(/^﻿/, '');
          same = text === content;
        }
        if (same) {
          if (!matches.some((match) => match.path === path)) {
            matches.push({ path, root });
          }
        } else {
          others.push({ path, root, size: info.size });
        }
      }
    }
  }
  if (matches.length === 1) {
    return { status: 'found', ...matches[0] };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous' };
  }
  return locateAlike(others, content, size, options.alikeBudgetMs ?? ALIKE_BUDGET_MS);
}
