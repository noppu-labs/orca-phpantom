# Contributing

orca-phpantom is an Orca plugin. The worker code is under `src/`, the editor that runs in each tab is under `editor/src/` and is built into `editor/dist/`, and `tests/` mirrors both.

## Reporting bugs and proposing changes

Report bugs and request features in the [issue tracker](https://github.com/noppu-labs/orca-phpantom/issues). For a bug, include the plugin version, the Orca version, the PHPantom version (hover the status bar item), your operating system, and what you expected to happen. The lines from `orca plugin logs noppu-labs.phpantom` help. Security problems go through private reporting instead, as [SECURITY.md](../SECURITY.md) describes.

Changes come in as pull requests against `main`. CI runs on each one, and `.github/CODEOWNERS` requests the maintainer's review.

Contributions are licensed under the repository's [MIT license](../LICENSE). By opening a pull request you state that you have the right to submit the change under that license, as GitHub's Terms of Service require of every contribution to a repository with a license ([section D.6](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)).

## Prerequisites

- Node 22.18 or newer, which runs the `.ts` build script directly. CI uses Node 22.
- Orca 1.4.259 or newer with the `orca` CLI on your `PATH`. CI installs `orca-ide` 1.4.277 from its pinned release (`.github/actions/setup-orca`).

```sh
npm install
orca plugin types .   # writes .orca/types, which tsconfig.json extends
```

## Running it from a checkout

```sh
orca plugin dev load .
```

Orca loads the folder as a development plugin. `orca plugin dev watch .` does the same and streams the logs, and `orca plugin dev reload` picks up a change. The worker's `.ts` files load as they are, but the editor tabs load `editor/dist`, so run `npm run build` after changing `editor/src`.

## Before opening a pull request

Run the same checks CI runs (`.github/workflows/ci.yml`):

```sh
orca plugin types .
npm run fmt:check       # oxfmt --check (npm run fmt rewrites in place)
npm run lint            # oxlint, type-aware, all five rule categories
npm run typecheck       # tsc -p . over src/, editor/src/, tests/ and scripts/
npm run build           # rebuilds editor/dist; commit what changes
orca plugin validate .
orca plugin check .
npm test                # orca plugin test .
npm run test:property   # the fast-check properties
```

CI fails when `editor/dist` differs from a fresh build, new files included. It also runs `PHPANTOM_INTEGRATION=1 orca plugin test .`, which downloads the real PHPantom release and checks it against its SHA-256 pin.

Fix a lint finding rather than silence it. When a rule can't apply to one line, use `// oxlint-disable-next-line <plugin>/<rule> -- <reason>`. Turning a rule off, everywhere or for `tests/**`, is a change to `.oxlintrc.json`.

## Property tests and fuzzing

Frame parsing, archive extraction, text chunking, Orca's size measure and URI keys have [fast-check](https://fast-check.dev) properties in `tests/property/*.property.ts`. Each file imports fast-check from `tests/property/setup.ts`, which also holds the shared text generator. `npm test` does not run them; they run under `node --test`.

`npm run test:property` runs each property 100 times, fast-check's default. `npm run fuzz` runs them 1,000 times (`FC_NUM_RUNS` overrides the count). The `fuzz` workflow runs 1,000 on every pull request and push to `main`, and 10,000 every Monday.

A failure prints a seed, a path and the smallest failing input. Reproduce it by passing `{ seed, path }` as the second argument to that `fc.assert`. If it is a real bug, fix it and add the input as an example test in the module's test file.

## Dependencies

The plugin has no runtime dependencies. Orca loads the worker without a bundler, so worker code imports only `orca` modules, Node builtins and relative files. Editor code follows the same rule, except for `monaco-editor`, which esbuild bundles into `editor/dist`. `editor/src/vendor/diff3.mjs` is a copied file for that reason (see `THIRD_PARTY_NOTICES.md`). Everything in `package.json` is under `devDependencies`: `monaco-editor` ends up in `editor/dist`, `esbuild` builds it, and the rest is tooling.

A dependency is added or changed only in a pull request, where it is reviewed like any other change. `package-lock.json` pins the whole tree and is committed. CI installs with `npm ci --ignore-scripts`, so it uses the locked versions and runs no install script. GitHub Actions are pinned to a commit SHA.

Dependabot opens weekly pull requests for npm packages and GitHub Actions (`.github/dependabot.yml`). `esbuild` and `monaco-editor` come in their own group, because a bump there changes the bundle: check out the branch, run `npm run build` and commit `editor/dist`.

## Layout

```
src/                  # the worker Orca runs (manifest main: src/main.ts)
├── main.ts           # entry: registers the phpantom.* handlers, commands and settings listener
├── protocol.ts       # the editor <-> worker requests and events, types only
├── controllers/      # router.ts: answers the editors' requests, one PHPantom per composer root
├── services/
│   ├── binary/       # finding, downloading, verifying and extracting phpantom_lsp
│   ├── locate/       # finding which file on disk an editor holds, and its workspace
│   ├── lsp/          # the PHPantom child process, JSON-RPC framing, the document mirror
│   └── outbox.ts, reveals.ts, status.ts
├── utils/            # json.ts, size.ts, uri.ts: pure helpers the editor also imports
└── constants/
editor/
├── pages/            # blade.html, php.html: the manifest's editor entries
├── src/              # Monaco, the bridge to the worker, the language feature providers
└── dist/             # build output, committed
scripts/build-editor.ts
tests/
├── worker/           # mirrors src/
├── editor/           # mirrors editor/src/
├── property/         # fast-check properties and their setup
├── helpers/, fixtures/
├── ship-set.test.ts  # what Orca would refuse to install
└── release-workflow.test.ts
docs/smoke/, docs/spike/   # manual test runs and an early locator experiment
```

Where things go:

- `src/main.ts` only wires the router to Orca. Logic belongs in `controllers/` or `services/`.
- `controllers/` handle the panel requests and commands and delegate to services. `services/` hold the logic and stay testable without Orca.
- `utils/` and `constants/` are pure and take no imports outside themselves, because the editor bundle reads them too.
- A new source file with logic gets a test at the matching path under `tests/worker/` or `tests/editor/`; the binary services share `tests/worker/services/binary/binary.test.ts`. A rule that holds for every input gets a property in `tests/property/`.
- Don't commit archives, files with the executable bit, native modules, bytecode, symlinks or TTF/OTF fonts. Orca's plugin indexer refuses a commit that holds one, and `tests/ship-set.test.ts` fails on any of them. The archive tests build their archives in memory (`tests/helpers/archives.ts`).

## The editor build

Orca installs a plugin as the files in its repository and runs no build step, and an editor frame loads only the plugin's own files, with no `node_modules`. So `scripts/build-editor.ts` bundles Monaco and `editor/src` into `editor/dist` with esbuild, and that output is committed. The build deletes the CSS esbuild writes beside a split chunk, which no page loads, and fails if that CSS holds a rule `main.css` lacks. It checks Orca's limits: no file over 10 MiB, at most 200 files. `tests/ship-set.test.ts` keeps a size budget below those limits, 6 MiB for the tracked tree and 5 MiB for `editor/dist`. CI rebuilds it on every pull request and fails on any difference.

## Releases

Releases are tagged by `.github/workflows/release.yml`; nobody runs `git tag` by hand.

1. A pull request into `main` bumps `version` in `orca-plugin.json` and `package.json`, which must match. Merging it is the decision to release.
2. Every push to `main` triggers `release.yml`. That run reads the version from `orca-plugin.json` and stops if `vX.Y.Z` already exists, so pushes that don't bump the version release nothing. Otherwise the `quality` job (typecheck, plugin tests, the `editor/dist` check, validate) and the `build` job (version gates, pack, checksums) run against the merge commit as a pre-check. The `tag` job then creates the annotated tag `vX.Y.Z` on that commit and dispatches `release.yml` at the tag. This run publishes nothing.
3. The dispatched run at the tag publishes. Provenance records `refs/tags/vX.Y.Z`.

If the pre-check fails, no tag exists. Fix the problem in another pull request; the next push to `main` with the same version tries again.

### Retries

- In the run started by the push to `main`, use "Re-run failed jobs". "Re-run all jobs" re-reads the version, sees that the tag already exists, and stops green without dispatching.
- In the publishing run at the tag, either "Re-run failed jobs" or a new dispatch works. Always pass `--ref` at the tag so provenance records the tag:

  ```sh
  gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z
  ```

- If the `tag` job failed after it created the tag, "Re-run failed jobs" runs it again. When the tag is on the same commit and has no release and no active run, the job dispatches the publishing run again. If the tag is on another commit, the job fails and nothing is dispatched.

If the `tag` job could not create the tag, push it by hand. The tag push starts the publishing run:

```sh
git tag -s vX.Y.Z <sha> -m vX.Y.Z && git push origin vX.Y.Z
```

Tags created by the workflow are annotated and unsigned.

### Repository rulesets

The workflow cannot protect itself, so `release.yml` expects two rulesets in the repository settings. `main` requires a pull request with a review and the CI check. `release tags` covers `refs/tags/v*` and blocks update and deletion, so a release tag never moves or disappears. It does not restrict creation: a repository ruleset cannot list the GitHub Actions app as a bypass actor, and the `tag` job creates tags with `GITHUB_TOKEN`. A hand-pushed tag still has to point at a commit on `main` and match the `orca-plugin.json` version, or `build` stops it before anything is published.

### What a release publishes

Nothing goes to a package registry. `release.yml` packs the tagged commit with `git archive`, which holds the same files Orca installs, and records the catalog entry from `orca-ide plugin release-entry`. It then opens a GitHub Release with the tarball, its build provenance attestation (`<tarball>.intoto.jsonl`), `release-entry.json` and `checksums-sha256.txt`. [SECURITY.md](../SECURITY.md#verifying-releases) shows how to check them.
