# orca-phpantom

Orca plugin that opens PHP files, Blade templates and Drupal's PHP files (`.module`, `.theme` and the rest) in a Monaco editor backed by the PHPantom language server. A trusted worker (`src/`) finds which file on disk each tab holds, runs one `phpantom_lsp --stdio` per Composer root, and relays LSP traffic between it and the editor frames (`editor/src/`, bundled into `editor/dist/`). It finds PHPantom on `PATH` or downloads the pinned 1.1.0 release, checked against its SHA-256. Orca installs the plugin from this repository's files, with no build step and no `node_modules`.

## Commands

```sh
npm install
orca plugin types .     # writes .orca/types; tsconfig.json extends it, so run it before typecheck
npm test                # orca plugin test . (tests/**/*.test.ts)
npm run test:property   # fast-check properties in tests/property/, under node --test
npm run fuzz            # the same properties, FC_NUM_RUNS times each (default 1000)
npm run typecheck       # tsc -p . over src/, editor/src/, tests/ and scripts/
npm run build           # bundles editor/src and Monaco into editor/dist with esbuild
npm run lint            # oxlint, all five categories, type-aware
npm run fmt             # oxfmt, rewrites files in place
npm run fmt:check       # oxfmt --check, what CI runs
orca plugin validate . && orca plugin check .
```

Node 22.18 or newer runs `scripts/build-editor.ts` directly. Lint is type-aware through `oxlint-tsgolint`; type checking stays with `tsc`. Fix a finding rather than silence it. When a rule can't apply to one line, use `// oxlint-disable-next-line <plugin>/<rule> -- <reason>`. Turning a rule off is a change to `.oxlintrc.json`.

## Layout

```
orca-plugin.json               # manifest: main src/main.ts, the php and blade editors, settings, commands, status bar item
src/
├── main.ts                    # worker entry: builds the Router, registers the phpantom.* handlers, commands and the settings listener
├── protocol.ts                # the editor <-> worker requests and events (declare module 'orca'), types only
├── controllers/
│   └── router.ts              # answers every phpantom.* request: attach, change, request, navigate, peek, ping, leases, restart, status
├── services/
│   ├── binary/
│   │   ├── release.ts         # PHPANTOM_VERSION, the six pinned assets and their SHA-256, the download URL
│   │   ├── resolve.ts         # lookup order (setting, PATH, well-known dirs, cache, download) and the cache folder
│   │   ├── find.ts            # findExecutable, wellKnownDirs, readVersion (runs --version), atLeast
│   │   ├── download.ts        # downloadVerified: fetch and check the SHA-256
│   │   ├── extract.ts         # extractSingleFile: one member from a tar.gz or zip, in memory
│   │   └── colour.ts          # writes the global .phpantom.toml for full colouring after a download
│   ├── locate/
│   │   ├── locate.ts          # locateFile: the file on disk whose text is the document's, exact or by shared lines
│   │   └── workspaces.ts      # isLocal, resolveFocused, composerRoot, workspaceFor
│   ├── lsp/
│   │   ├── server.ts          # PhpantomServer: one child process, initialize, server requests and notifications, stop
│   │   ├── jsonrpc.ts         # RpcConnection: Content-Length framing, requests, cancellation
│   │   ├── capabilities.ts    # CLIENT_CAPABILITIES sent in initialize
│   │   ├── mirror.ts          # DocumentMirror: the worker's copy of a document, applies LSP changes
│   │   └── rpc-error.ts       # RpcError
│   ├── outbox.ts              # keyed, rate-limited posts to editor frames within Orca's limits
│   ├── reveals.ts             # PendingReveals: target ranges waiting for the tab that opens them
│   └── status.ts              # aggregate and renderStatus for the status bar item
├── utils/                     # pure, also imported by the editor bundle
│   ├── json.ts                # isRecord, isTruthy
│   ├── size.ts                # orcaSize: a value measured the way Orca measures it; fitsIn, leadingThatFit
│   └── uri.ts                 # uriKey, sameUri, isFileUri
└── constants/                 # no imports; the editor bundle reads them, the build script reads units.ts
    ├── characters.ts          # line-ending and surrogate code units
    ├── orca-measure.ts        # the bytes Orca counts per number, array and slot
    └── units.ts               # BYTES_PER_KIB
editor/
├── pages/
│   ├── blade.html             # the blade editor entry: sets the language, loads dist/main.js
│   └── php.html               # the php editor entry, the same page for PHP
├── src/
│   ├── main.ts                # bundle entry: startEditor, then attachLanguageServer
│   ├── editor.ts              # Monaco in the frame, bound to Orca's document session, theme and font
│   ├── monaco.ts              # the one module that imports monaco-editor; registers PHP, HTML and Blade
│   ├── editor.worker.ts       # Monaco's editor worker entry
│   ├── attach.ts              # connects the Monaco model to the bridge: markers, reveals, notes, providers
│   ├── bridge.ts              # LspBridge: attach in chunks, stream changes, forward requests, re-attach, pings
│   ├── frame-host.ts          # Orca's frame API as a BridgeHost
│   ├── sync.ts                # bindDocument: Monaco <-> Orca document session; flushWhenHidden
│   ├── model-view.ts          # applies Orca's outside writes to the Monaco model
│   ├── merge.ts               # mergeText: three-way line merge for an outside write over local edits
│   ├── edits.ts               # smallestEdit between two texts
│   ├── split.ts               # chunkText and splitChanges under Orca's 64 KiB request limit
│   ├── pacer.ts               # Pacer: this tab's share of Orca's 120 frame calls per 10 s
│   ├── navigation.ts          # opening other files, read-only peek models
│   ├── lsp-convert.ts         # pure LSP <-> Monaco conversions
│   ├── blade.ts               # the Blade Monarch grammar over Monaco's HTML grammar
│   ├── theme.ts               # dark and light themes with the semantic token rules
│   ├── notes.ts               # short notes over the editor
│   ├── providers/
│   │   ├── shared.ts          # what the providers share: types, cancellation, disposal
│   │   ├── diagnostics.ts     # PHPantom's diagnostics as Monaco markers
│   │   ├── reading.ts         # completion, hover, signature help, semantic tokens, inlay hints, outline
│   │   └── editing.ts         # definitions, references, formatting, rename, code actions
│   ├── vendor/diff3.mjs       # copy of node-diff3 3.2.1 (see THIRD_PARTY_NOTICES.md)
│   ├── env.d.ts               # the __PHPANTOM_LANGUAGE__ global the pages set
│   └── monaco-modules.d.ts    # types for Monaco's HTML language definition
└── dist/                      # build output, committed
scripts/build-editor.ts        # esbuild bundle into editor/dist, checks Orca's 10 MiB and 200-file limits
tests/
├── worker/                    # mirrors src/ (tests/worker/services/lsp/server.test.ts tests src/services/lsp/server.ts)
├── editor/                    # mirrors editor/src/
├── property/                  # *.property.ts fast-check properties; setup.ts applies FC_NUM_RUNS
├── helpers/                   # archives.ts (builds tar.gz and zip in memory), fake-source.ts, monarch-walk.ts
├── fixtures/fake-server.mjs   # a tiny language server for the server and router tests
├── ship-set.test.ts           # what Orca's plugin indexer would refuse, install limits, matching versions
└── release-workflow.test.ts   # structural checks on release.yml
```

Other top-level files: `docs/` (`CONTRIBUTING.md`, `ARCHITECTURE.md`, `SECURITY_ASSESSMENT.md`, `GOVERNANCE.md`, manual smoke runs in `smoke/`, the locator experiment in `spike/`), `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `.github/` (workflows `ci`, `fuzz`, `scorecard`, `release`; the `setup-orca` action; Dependabot; CODEOWNERS).

Where new code goes:

- `src/main.ts` only wires the router to Orca. Logic belongs in `controllers/` or `services/`.
- `controllers/` handle panel requests and commands and delegate to services. `services/` hold the logic and stay testable without Orca.
- `utils/` and `constants/` are pure and shared with the editor; keep them free of Node-only imports.
- A type shared by the editor and the worker goes in `src/protocol.ts`. Fixed values go in `constants/` or a named constant, not inline.
- Editor code that can run without Monaco stays free of it (`bridge.ts`, `lsp-convert.ts`, `split.ts` and others), so Node tests it. Only `editor/src/monaco.ts` imports `monaco-editor`.
- A source file with logic gets a test at the matching path under `tests/worker/` or `tests/editor/`. A rule that holds for every input gets a property in `tests/property/`.

## Rules

- Worker and editor code import only `orca` modules, Node builtins and relative files. Orca loads plugins without a bundler, and `orca plugin test` refuses any other bare import.
- `editor/dist` is committed and must match a fresh `npm run build`; CI fails on any difference. Rebuild and commit it after changing `editor/src` or bumping `monaco-editor` or `esbuild`.
- No symlinks, archives, files with the executable bit, native modules, bytecode or TTF/OTF fonts in the repo. Orca refuses a plugin that holds one; `tests/ship-set.test.ts` checks every tracked file. That is why `AGENTS.md` and `CLAUDE.md` are two files.
- Orca's limits: 2,000 files and 50 MiB for the folder, 10 MiB per editor file, 1 MiB per `.ts` file. Requests from a frame are at most 64 KiB, answers 1 MiB, worker posts 256 KiB, all by Orca's measure (`src/utils/size.ts`).
- `orca-plugin.json` keeps `main` at `src/main.ts` and the two `entry` paths as they are. Its `version` and `package.json`'s must match.
- `PHPANTOM_VERSION` and the SHA-256 pins live in `src/services/binary/release.ts`. A new PHPantom release means new pins for all six assets, and the version also appears in the not-found message in `resolve.ts` and in the README.
- The frame drops an answer that edits text (formatting, rename, a resolved code action) when the text moved while it waited, and refuses an edit that reaches another file.
- Every GitHub Action is pinned to a full commit SHA with a version comment, every workflow declares `permissions`, and checkouts use `persist-credentials: false`.
- Releases go through `.github/workflows/release.yml`: a push to `main` whose `orca-plugin.json` version has no `v*` tag is pre-checked, tagged, and published from a run dispatched at the tag. Do not tag or publish by hand.
- A change to an external interface (the `phpantom.*` requests and events, settings, commands, the download, files the worker writes) also updates `docs/ARCHITECTURE.md`, and `docs/SECURITY_ASSESSMENT.md` when it changes a risk or a safeguard.
- Run `npm run fmt:check`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run test:property` before calling work done.
