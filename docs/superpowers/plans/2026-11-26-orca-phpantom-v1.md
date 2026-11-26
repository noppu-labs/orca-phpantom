# PHPantom for Orca v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (a single executor drives it; superpowers:executing-plans only if no subagent tool is available). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Orca plugin whose own editor opens `.php` and `.blade.php` files and gets diagnostics, completion, hover, navigation, colouring, formatting, rename and quick fixes from a `phpantom_lsp` process the plugin's worker runs per workspace root.

**Architecture:** Two custom editors (`php`, `blade`) load one prebuilt Monaco bundle in Orca's isolated frame, keep the document in sync with `orca.document.session()`, and forward LSP traffic to the plugin's `trusted-worker` over `plugin.request` (editor to worker) and `orca.panels.post` (worker to editor). The worker finds which file the editor holds (the frame never learns its path), runs one PHPantom child per composer root over stdio, and resolves or downloads the pinned PHPantom binary.

**Tech Stack:** TypeScript (worker transpiled by Orca, no build step); `monaco-editor@0.57.0` bundled with `esbuild@0.28.2` into committed `editor/dist`; `node-diff3@3.2.1` (bundled into the editor) for three-way merge; `orca plugin test` (node:test plus `orca/testing`), `orca plugin validate`, `orca plugin check`; `typescript@5.9.3` for `tsc` only; PHPantom `1.1.0`.

**Spec:** `docs/superpowers/specs/2026-11-26-orca-phpantom-design.md`. Read it first. It is the source of truth; where this plan narrows a choice the spec left to the builder, the plan says so.

## Global Constraints

- Plugin id `phpantom`, display name `PHP & Laravel (PHPantom)`, installs as `noppu-labs.phpantom`. No `publisher` field. Repo `noppu-labs/orca-phpantom`, MIT.
- `engines.orca` is `>=1.4.257` (newest `Since` used: `editor.readTypography` from the editor surface, host API 1.6). `pluginApi: 1`. `execution: "trusted-worker"`.
- Both custom editors use `"frame": "isolated"` and `"priority": "default"`.
- Capabilities: `settings:own`, `workspace:read`, `workspace:write`. `workspace:write` is needed for `editor.open`; the spec does not mention it (flagged for the owner).
- Settings: `phpantomPath` (string, default `""`, empty = auto) and `allowDownload` (boolean, default `true`). Nothing else.
- Orca limits: `plugin.request` input at most 64 KiB, answer at most 1 MiB, default timeout 30 s (max 120 s); posts at most 256 KiB each and 200 per 10 s per plugin; plugin folder at most 50 MiB and 2,000 files; editor `entry` at most 10 MiB; each `.ts` Orca transpiles at most 1 MiB; 16 custom editors, 32 extensions each.
- The worker has no `node_modules` when installed: worker code (`src/**`) imports Node builtins and relative files only. npm packages are allowed only in editor code, which esbuild bundles into `editor/dist`.
- `editor/dist` is committed and must equal a fresh `node editor/build.mjs` (CI checks it).
- Pinned PHPantom: `1.1.0` (released 2026-11-24, also the minimum accepted from `PATH`). Release assets, each archive holding one file at its root (`phpantom_lsp`, or `phpantom_lsp.exe` in the zips):

  | `process.platform`-`process.arch` | Asset | SHA-256 |
  | --- | --- | --- |
  | `darwin-arm64` | `phpantom_lsp-aarch64-apple-darwin.tar.gz` | `7ce64bbb0aea4e421cbc055f1b5b0cde36eaeb0ccb14da235f136447d29c6b70` |
  | `darwin-x64` | `phpantom_lsp-x86_64-apple-darwin.tar.gz` | `6f66e490f41b2d013b3aba0abe60d5909af1a83f10417dc253a0dfbaebab7866` |
  | `linux-arm64` | `phpantom_lsp-aarch64-unknown-linux-gnu.tar.gz` | `888633fd40b9af4709338af7cc76a34e9096f4259812cd24911109af1d068c5f` |
  | `linux-x64` | `phpantom_lsp-x86_64-unknown-linux-gnu.tar.gz` | `f374e72ebd51d5e991bb0e7e395ec3a49b3dc75f101e69e4743f908515e9d7e7` |
  | `win32-arm64` | `phpantom_lsp-aarch64-pc-windows-msvc.zip` | `d6c1b8fedca8cb01f8128f863ed5eed2abd2b8b6f00c537ab518ef74c59ace73` |
  | `win32-x64` | `phpantom_lsp-x86_64-pc-windows-msvc.zip` | `9b5b93400171881517a36dc34ac330db733399a6faaec7e88eec18d3189d11bd` |

  Download URL: `https://github.com/PHPantom-dev/phpantom_lsp/releases/download/1.1.0/<asset>`. Values were hashed locally on 2026-11-26 and match the digests GitHub records for the release.
- No network use other than that one download. Never send document text anywhere but the local PHPantom child.
- Editing is never worse than Orca's Source view: no lost keystrokes, no dropped draft when an agent writes the file, undo intact, providers never block typing.
- Reused Autocomplete code is copied from `actus7/orca-autocomplete` at commit `da5a6803f4a4b2c30be8591795682f76c02ad347` (MIT, Copyright (c) 2026 actus7). Each vendored file starts with `// Adapted from actus7/orca-autocomplete <path> @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.` and `THIRD_PARTY_NOTICES.md` carries the full MIT text.
- Do not add the `orca-plugin` GitHub topic and do not tag a release in this plan.

### Facts this plan relies on (verified 2026-11-26 against `phpantom_lsp 1.1.0`)

- `initialize` result: `textDocumentSync` `{ openClose: true, change: 2 (incremental), save: { includeText: false } }`; `completionProvider` with `resolveProvider: true` and trigger characters `$ > : @ ' " [ \ / *`; `hoverProvider`; `signatureHelpProvider` (trigger `(` `,`, retrigger `,` `)`); `declarationProvider`, `definitionProvider`, `typeDefinitionProvider`, `implementationProvider`, `referencesProvider`, `documentHighlightProvider`, `documentSymbolProvider`; `codeActionProvider` with `resolveProvider: true` and kinds `quickfix refactor refactor.extract refactor.inline refactor.rewrite source.organizeImports source.addMissingImports`; `documentFormattingProvider`, `documentRangeFormattingProvider`; `renameProvider: { prepareProvider: true }`; `inlayHintProvider: true`; `semanticTokensProvider` with `full: true`, `range: false` and legend types `namespace class interface enum type typeParameter parameter variable property function method decorator enumMember keyword comment`, modifiers `declaration static readonly deprecated abstract definition defaultLibrary`; `diagnosticProvider` (pull). It also offers code lens, folding, selection range, call and type hierarchy and workspace symbols, which v1 does not use.
- Diagnostics are pushed with `textDocument/publishDiagnostics` when the client does not advertise `textDocument.diagnostic`. The client must not advertise it.
- Code actions come back without `edit`, carrying `data`; the edit arrives only from `codeAction/resolve`.
- Semantic tokens default to `[semantic-tokens] mode = "contextual"` (parameters, template parameters, deprecated and static member references only); `full` mode is set by the user in `.phpantom.toml`, not by the client.
- Blade: PHPantom treats a URI ending `.blade.php`, or a document opened with `languageId: "blade"`, as Blade. The worker sends `languageId: "blade"` for Blade documents and `"php"` for the rest.
- During startup PHPantom sends `window/workDoneProgress/create`, `$/progress` (titles `PHPantom: Indexing`, `PHPantom: Full index`), `window/logMessage`, and `workspace/inlayHint/refresh`.
- PHPantom exits within about 300 ms when its stdin closes, so a dead worker does not leave children behind.
- Formatting answers one whole-document edit, or `null` when nothing changes.
- The downloaded macOS binary is signed with the hardened runtime and runs from a cache folder.
- Monaco 0.57.0 entry points (the ESM layout changed in 0.56): `monaco-editor/editor`, `monaco-editor/features/register.all`, `monaco-editor/languages/definitions/php/register`, `monaco-editor/languages/definitions/html/register`, `monaco-editor/languages/definitions/html/html` (exports `conf`, `language`; ships no `.d.ts`), worker `monaco-editor/editor/editor.worker`. A probe bundle came to 7 files and 4.5 MB, byte-identical across two builds.
- Standalone Monaco colours a semantic token from the theme rule matching `type.modifier…`; with no rule it falls back to the theme's default foreground, so every legend type needs a rule.
- Monaco's `IModelContentChangedEvent.changes` are ordered from the end of the document to the start, so they can be sent as LSP `contentChanges` in the same order.

## Review Focus

1. **An agent writes the open file while the person has unsaved edits in the same lines.** Expected: both versions survive in the buffer, wrapped in conflict markers, with a note; nothing is dropped or silently overwritten. Test: Task 3, `keeps both sides when an agent rewrites the lines being edited`.
2. **A paste over 64 KiB, or opening a 1 MB file.** Expected: the change reaches PHPantom split across requests with no character lost, and a version gap or length mismatch triggers a full resync instead of drift. Tests: Task 7, `split changes rebuild the same text`; Task 9, `a gap in versions asks for a resync`.
3. **The same file is byte-identical in two worktrees, or a tab is restored in the background.** Expected: it attaches to the focused worktree's copy and re-attaches when its tab becomes visible under a different focused workspace; it never attaches to a remote workspace's look-alike. Tests: Task 8, `prefers the focused worktree when both copies match`; Task 10, `re-attaches when the tab shows under another workspace`.
4. **The worker or a PHPantom child restarts mid-session.** Expected: editors notice (new session id, `unavailable` or `detached`), re-open their document within a few seconds, pending reveals are dropped, and nothing keeps answering from a dead server. Tests: Task 9, `answers detached after a server crash`; Task 10, `re-opens after the worker reports a new session`.
5. **A branch switch makes PHPantom publish diagnostics for hundreds of files.** Expected: only attached documents are posted, the latest set wins, posts stay under 200 per 10 s and 256 KiB each, and the final state always arrives. Test: Task 9, `keeps posts under the rate limit and delivers the last set`.

---

## File structure

The plugin folder is the repo root.

```
orca-plugin.json                 manifest (Task 2)
package.json, package-lock.json  dev tooling only (esbuild, monaco-editor, node-diff3, typescript, @types/node)
tsconfig.json                    extends .orca/types/tsconfig.json; includes src, editor/src
THIRD_PARTY_NOTICES.md           Autocomplete MIT notice
README.md
.github/workflows/ci.yml
src/                             worker: Node builtins and relative imports only
  main.ts                        activate(orca): wiring only
  protocol.ts                    editor <-> worker contract (types)
  router.ts                      request handlers, document table, server pool
  outbox.ts                      rate-limited, coalescing posts
  status.ts                      status bar state
  reveals.ts                     pending cross-file reveals
  binary/release.ts              pinned version, asset table
  binary/find.ts                 PATH and well-known lookup, version check
  binary/extract.ts              single-member .tar.gz / .zip extraction
  binary/download.ts             fetch + SHA-256 verify
  binary/resolve.ts              resolution order, cache folder
  lsp/jsonrpc.ts                 vendored, plus cancellation
  lsp/uri.ts                     vendored
  lsp/capabilities.ts            client capabilities sent in initialize
  lsp/server.ts                  one PHPantom child
  lsp/mirror.ts                  worker copy of an open document
  lsp/fixtures/fake-server.mjs   test language server
  locate/locate.ts               file locator (adapted)
  locate/workspaces.ts           focused workspace, composer root, local/remote
editor/
  build.mjs                      esbuild -> editor/dist
  pages/php.html, pages/blade.html
  dist/                          committed bundle
  src/main.ts                    bundle entry: startEditor, then attachLanguageServer
  src/editor.ts                  Monaco editor and document binding (startEditor)
  src/attach.ts                  language server wiring (attachLanguageServer)
  src/monaco.ts                  Monaco imports and language registration
  src/blade.ts                   Blade Monarch grammar layered on HTML
  src/theme.ts                   themes, semantic rules, typography options
  src/merge.ts                   three-way text merge
  src/edits.ts                   vendored smallestEdit
  src/sync.ts                    document session <-> Monaco model binding
  src/split.ts                   request-size splitting
  src/bridge.ts                  attach / change / ask / reattach
  src/lsp-convert.ts             vendored and extended LSP <-> Monaco conversion
  src/providers.ts               Monaco provider registration
  src/navigation.ts              cross-file open, peek models
  src/notes.ts                   note bar
  src/env.d.ts, src/monaco-modules.d.ts
```

Vendor or rewrite, per Autocomplete module:

| Autocomplete module | Decision | Why |
| --- | --- | --- |
| `src/lsp/jsonrpc.ts` | Vendor, add cancellation | Correct framing, small, tested upstream |
| `src/lsp/uri.ts` | Vendor as is | Pure |
| `editor/src/lsp-convert.ts` | Vendor, extend | Pure conversions; needs content changes, inlay hints, semantic tokens, code actions |
| `editor/src/edits.ts` (`smallestEdit`) | Vendor as is | Keeps cursor and undo on outside changes |
| `src/lsp/locate.ts` | Adapt | Skips `vendor/`, treats all roots equally, keys `.blade.php` as `.php`; needs tiers and reveal candidates |
| `src/lsp/manager.ts` | Rewrite, using its `Server` class as reference | Full-text sync, no progress, no refresh requests, no restart model |
| `src/lsp/servers.ts` | Drop, vendor only `findExecutable` | We run one server and resolve its binary ourselves |
| `editor/src/lsp.ts` | Rewrite, using it as reference | Full-text sync over a 64 KiB channel, same-file navigation only, drops `data`-only code actions, no semantic tokens or inlay hints |
| `src/protocol.ts`, `src/main.ts` | Rewrite | Different contract |
| `editor/build.mjs`, `editor/languages.mjs` | Rewrite (keep its esbuild options) | Two hand-written pages, no generated manifest |
| `editor/src/editor-options.ts`, `theme.ts` | Rewrite | The frame reads `editor.readTypography` itself |

---

### Task 1: Spike: locate the open file across two worktrees (go/no-go)

Throwaway code, outside the repo. Only the report is committed.

**Files:**
- Create: `docs/spike/locator-spike.md` (the report)
- Scratch (not committed): `$TMPDIR/phpantom-spike/`

**Interfaces:**
- Consumes: nothing.
- Produces: the report's answers, which later tasks rely on: how `workspace.readContext().workspaceId` maps to a `workspace.list` row (Task 8 `resolveFocused`), the `path` form `editor.open` accepts (Task 12), whether `.blade.php` opens the `blade` editor (Task 4), the worker's `PATH` when Orca starts from the Dock (Task 5), and which editor wins `.php` when Autocomplete is also installed (Task 13).

- [ ] **Step 1: Prepare a repo with two worktrees open in Orca**

Use any local git repo with a PHP file (a Laravel app is best). Create a second worktree on a new branch so `app/Example.php` (any PHP file) is byte-identical in both, and open both worktrees as workspaces in Orca. Add a `.blade.php` file if the repo has none.

- [ ] **Step 2: Scaffold the spike plugin**

Run: `orca plugin create "$TMPDIR/phpantom-spike" --template editor --id phpantom-spike`
Then edit it into a `trusted-worker` plugin: `main: "worker.ts"`, capabilities `workspace:read` and `workspace:write`, and two custom editors (`php` with `[".php"]`, `blade` with `[".blade.php"]`, each `"frame": "isolated"`, entries `php.ts` and `blade.ts` that differ only in a `LANGUAGE` constant).
- Editor (each entry): `const ctx = await orca.host.call('workspace.readContext', {})`; `const doc = await orca.document.session()`; `await orca.plugin.request('spike.locate', { language: LANGUAGE, ctx, text: doc.value })`; show the answer in the textarea's title.
- Worker: `spike.locate` calls `workspace.list`, logs `ctx` and every row's `{ id, name, branch, path, hostId }`, picks the row whose `id === ctx.workspaceId` (else the row with the same `branch` and `name === ctx.displayName`), walks that row's `path` for files of the language's suffix whose content equals `text` exactly, and logs and returns `{ matchedBy: 'id' | 'branch+name' | 'none', path, matches }`. It also logs `process.env.PATH` once on activate.
- Worker handler `orca.panels.handle('spike.open', ({ workspaceId, path }) => …)` calls `editor.open` and returns the result or the error code.

- [ ] **Step 3: Load it and run the trials**

Run: `orca plugin dev load "$TMPDIR/phpantom-spike"` (re-run with the printed `--approve <fingerprint>`), then `orca plugin logs local.phpantom-spike` after each trial. For each trial, focus the workspace in Orca first, then run `orca plugin open local.phpantom-spike --editor <absolute file path>` (or click the file in Orca's tree).
- Trial A1/A2: open `app/Example.php` from worktree A twice (close the tab in between). Trial B1/B2: the same from worktree B.
- Trial C: open the `.blade.php` file and a `.php` file by clicking them in Orca's file tree (not `orca plugin open --editor`, which forces the editor); record which editor (`php`, `blade` or Orca's Source) loaded each by default.
- Trial D: `orca plugin dev request "$TMPDIR/phpantom-spike" spike.open --data '{"workspaceId":"<A id>","path":"app/Models/User.php"}'`, then the same with the absolute path, then with a path outside every workspace. Record each result.
- Trial E: quit Orca, start it from the Dock (not a terminal), and record the `PATH` line the worker logs.
- Trial G: have the editor also log `workspace.readContext` on every `visibilitychange`. Open the file in worktree A, switch to worktree B, quit and restart Orca while B is focused, then switch back to A; record what the restored A tab's editor logged at start and when it became visible (Task 10's re-attach relies on it).
- Trial F (only if Autocomplete is installed): with both plugins enabled, open a `.php` file and record which editor opens by default.

- [ ] **Step 4: Decide go or no-go**

GO when, in all four A/B trials, the editor's `workspaceId` maps to the focused worktree's row (`matchedBy` is `id`, or `branch+name` with a note) and the exact-content search rooted at that row's `path` returns exactly that worktree's file. NO-GO when the editor surface cannot call `workspace.readContext`, gets `null` while a workspace is focused, or maps to the other worktree.

- [ ] **Step 5: Write the report**

`docs/spike/locator-spike.md`: Orca version, the repo shape, the raw log lines for each trial, the answers listed under Interfaces → Produces, the go/no-go verdict with one sentence of evidence, and the spike's editor and worker code (about 60 lines) inline so a reviewer can rerun it.

- [ ] **Step 6: Commit and report**

```bash
git add docs/spike/locator-spike.md
git commit -m "docs: record the locator spike and its go/no-go"
```
Report the verdict and the report path to whoever dispatched you before starting Task 2 (in Orca: `orca orchestration send --type escalation` on NO-GO, a short status message on GO). On NO-GO stop here. On GO, continue; if `matchedBy` was `branch+name`, Task 8's `resolveFocused` keeps that fallback (it is specified either way). If `.blade.php` opened the `php` editor, stop and report: Task 4's two-editor design needs a different routing.

---

### Task 2: Scaffold, manifest, protocol and CI

**Files:**
- Create: `orca-plugin.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.gitattributes`, `THIRD_PARTY_NOTICES.md`, `README.md`, `src/main.ts`, `src/protocol.ts`, `src/status.ts`, `src/status.test.ts`, `editor/pages/php.html`, `editor/pages/blade.html` (stubs), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1 report (GO).
- Produces: the manifest below; the protocol below (every later task uses these names unchanged); `renderStatus(state: StatusState): StatusBarUpdate` and `aggregate(states: ServerState[]): StatusState` in `src/status.ts`.

`orca plugin create` only writes into an empty folder, so scaffold into `$TMPDIR/phpantom-scaffold` with `--template worker-panel`, copy `.gitignore`, `.gitattributes`, `tsconfig.json`, then drop its panel and counter code.

Manifest (exact):

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "phpantom",
  "name": "PHP & Laravel (PHPantom)",
  "version": "0.1.0",
  "description": "PHP and Blade editing powered by PHPantom: errors, completion, hover, go to definition and Laravel awareness.",
  "license": "MIT",
  "repository": "https://github.com/noppu-labs/orca-phpantom",
  "engines": { "orca": ">=1.4.257" },
  "pluginApi": 1,
  "main": "src/main.ts",
  "capabilities": [{ "kind": "settings:own" }, { "kind": "workspace:read" }, { "kind": "workspace:write" }],
  "contributes": {
    "customEditors": [
      { "id": "php", "title": "PHPantom", "extensions": [".php"], "entry": "editor/pages/php.html", "priority": "default", "frame": "isolated" },
      { "id": "blade", "title": "PHPantom", "extensions": [".blade.php"], "entry": "editor/pages/blade.html", "priority": "default", "frame": "isolated" }
    ],
    "settings": [
      { "key": "phpantomPath", "title": "PHPantom binary", "description": "Full path to phpantom_lsp. Leave empty to find it on PATH or download it.", "type": "string", "default": "", "placeholder": "/opt/homebrew/bin/phpantom_lsp" },
      { "key": "allowDownload", "title": "Download PHPantom when missing", "description": "Fetch the pinned PHPantom release from GitHub and check its SHA-256 when none is installed.", "type": "boolean", "default": true }
    ],
    "commands": [
      { "id": "phpantom.status", "title": "PHPantom: Show status" },
      { "id": "phpantom.restart", "title": "PHPantom: Restart language servers" }
    ],
    "statusBarItems": [
      { "id": "phpantom", "text": "PHPantom", "icon": "code", "tone": "neutral", "tooltip": "PHPantom", "command": "phpantom.status" }
    ]
  }
}
```

Protocol (`src/protocol.ts`, types only, imported by the editor as `../../src/protocol.ts`):

```ts
export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }
export type LspContentChange = { range: LspRange; text: string } | { text: string }
export type Language = 'php' | 'blade'
export type AttachStatus =
  | { state: 'ready'; session: string; uri: string; capabilities: Record<string, unknown>; approximate?: true; reveal?: LspRange }
  | { state: 'pending' }                                  // more chunks expected
  | { state: 'single-file'; reason: 'no-file' | 'ambiguous' }
  | { state: 'remote'; host: string }
  | { state: 'error'; message: string }
declare module 'orca' {
  interface PluginRequests {
    'phpantom.open': { input: { docId: string; language: Language; workspaceId: string | null; branch: string | null; displayName: string | null; index: number; chunk: string; last: boolean; resync?: true }; output: AttachStatus }
    'phpantom.change': { input: { docId: string; session: string; version: number; changes: LspContentChange[]; length: number }; output: { ok: true } | { detached: true } | { resync: true } }
    'phpantom.request': { input: { docId: string; session: string; method: string; params: Record<string, unknown> }; output: { result: unknown } | { detached: true } | { error: string } }
    'phpantom.close': { input: { docId: string }; output: { ok: true } }
    'phpantom.navigate': { input: { docId: string; session: string; uri: string; range: LspRange }; output: { opened: true } | { opened: false; reason: 'outside-workspace' | 'not-a-file' | 'failed' } }
    'phpantom.peek': { input: { docId: string; session: string; uris: string[] }; output: { files: { uri: string; text: string }[]; omitted: number } }
  }
  interface PluginPanelEvents {
    'phpantom.diagnostics': { docId: string; diagnostics: unknown[]; truncated: number }
    'phpantom.status': { docId: string; state: 'restarting' | 'stopped' | 'error'; message?: string }
    'phpantom.refresh': { kinds: ('semanticTokens' | 'inlayHints' | 'codeLens' | 'diagnostics')[] }
    'phpantom.reveal': { docId: string; range: LspRange }
  }
}
```

Status types (`src/status.ts`): `type ServerState = { phase: 'downloading' | 'starting' | 'indexing' | 'ready' | 'error'; percent?: number; message?: string }`, `type StatusState = { phase: 'idle' | ServerState['phase']; percent?: number; message?: string; version?: string; source?: 'setting' | 'path' | 'cache' | 'download' }`, `type StatusBarUpdate = { id: 'phpantom'; text: string; icon: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip: string }`. `aggregate` picks the most urgent phase in the order `error > downloading > starting > indexing > ready`, `idle` for none, and the lowest `percent` among indexing servers.

- [ ] **Step 1: Write the failing status tests** (`src/status.test.ts`)

```ts
import { assert, test } from 'orca/testing'
import { aggregate, renderStatus } from './status.ts'

test('no servers renders idle', () => {
  assert.deepEqual(renderStatus(aggregate([])), { id: 'phpantom', text: 'PHPantom', icon: 'code', tone: 'neutral', tooltip: 'PHPantom: no PHP files open' })
})
test('an error outranks indexing', () => {
  const s = aggregate([{ phase: 'indexing', percent: 40 }, { phase: 'error', message: 'exited (code 1)' }])
  assert.equal(s.phase, 'error')
  assert.deepEqual(renderStatus(s), { id: 'phpantom', text: 'PHPantom: error', icon: 'error', tone: 'danger', tooltip: 'PHPantom: exited (code 1)' })
})
test('indexing shows the lowest percent', () => {
  assert.equal(renderStatus(aggregate([{ phase: 'indexing', percent: 70 }, { phase: 'indexing', percent: 20 }])).text, 'PHPantom: indexing 20%')
})
test('ready names the version and where it came from', () => {
  assert.deepEqual(renderStatus({ phase: 'ready', version: '1.1.0', source: 'download' }), { id: 'phpantom', text: 'PHPantom', icon: 'check', tone: 'neutral', tooltip: 'PHPantom 1.1.0 (downloaded), ready' })
})
```
Other phases render: `downloading` → text `PHPantom: downloading`, icon `download`, tone `accent`; `starting` → `PHPantom: starting`, icon `refresh`, tone `neutral`. Tooltip source words: `setting` → `from settings`, `path` → `from PATH`, `cache` → `cached`, `download` → `downloaded`.

- [ ] **Step 2: Run them and see them fail**

Run: `orca plugin types . && orca plugin test .`
Expected: FAIL, `Cannot find module './status.ts'`.

- [ ] **Step 3: Implement `src/status.ts`, `src/protocol.ts`, the manifest, and `src/main.ts`**

`main.ts` for now: default-export `activate(orca)` that calls `statusBar.update` with `renderStatus(aggregate([]))` and registers `phpantom.status` (returns the tooltip) and `phpantom.restart` (returns `'Nothing to restart'`). `package.json`: `"private": true, "type": "module"`, scripts `build` (`node editor/build.mjs`), `test` (`orca plugin test .`), `typecheck` (`tsc -p .`); devDependencies pinned exactly: `esbuild 0.28.2`, `monaco-editor 0.57.0`, `node-diff3 3.2.1`, `typescript 5.9.3`, `@types/node` (the newest 22.x at install time, written exactly). `tsconfig.json` includes `src` and `editor/src`. `THIRD_PARTY_NOTICES.md`: the Autocomplete MIT text with its copyright line and the commit SHA. `README.md`: what it is, install with `orca plugin install noppu-labs/orca-phpantom`, the binary resolution order, desktop-only, local workspaces only.

- [ ] **Step 4: Run tests, typecheck, validate**

Run: `orca plugin test . && npx tsc -p . && orca plugin validate .`
Expected: 4 tests pass; `tsc` prints nothing; validate exits 0. The two pages are stubs for now (a minimal HTML document with `<div id="root"></div>`) so validate finds the editor entries; Task 4 replaces them.

- [ ] **Step 5: Add CI** (`.github/workflows/ci.yml`)

One `ubuntu-latest` job on push and pull request: `actions/checkout@v7`, `actions/setup-node@v7` (node 22), then install Orca's CLI from the `.deb` without installing the app:

```bash
cd "$RUNNER_TEMP"
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o orca.deb \
  "https://github.com/stablyai/orca/releases/download/v1.4.277/orca-ide_1.4.277_amd64.deb"
echo "46fb018af43fa9e47b4a4c9f681a66ecc871d231be896298301cd0e2c2e8d952  orca.deb" | sha256sum -c -
dpkg-deb -x orca.deb orca
dirname "$(find "$RUNNER_TEMP/orca" -type f -name orca-ide -path '*resources/bin/*' | head -1)" >> "$GITHUB_PATH"
```
Then: `orca-ide --version`, `npm ci --ignore-scripts`, `orca-ide plugin types .`, `npx tsc -p .`, `orca-ide plugin validate .`, `orca-ide plugin check .`, `orca-ide plugin test .`, and the build reproducibility check `node editor/build.mjs && git diff --exit-code -- editor/dist` (add that line in Task 4, when the build exists). On Linux the CLI is `orca-ide`, not `orca`.

- [ ] **Step 6: Commit**

```bash
git add orca-plugin.json package.json package-lock.json tsconfig.json .gitignore .gitattributes THIRD_PARTY_NOTICES.md README.md src editor/pages .github
git commit -m "feat: scaffold the PHPantom plugin with its manifest, protocol, status bar and CI"
```

---

### Task 3: Document sync and three-way merge

**Files:**
- Create: `editor/src/merge.ts`, `editor/src/merge.test.ts`, `editor/src/edits.ts` (vendored `editor/src/edits.ts`, `smallestEdit` and `Splice` only), `editor/src/edits.test.ts` (vendored), `editor/src/sync.ts`, `editor/src/sync.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `mergeText(base: string, outside: string, mine: string): { text: string; conflicts: number }`
  - `smallestEdit(before: string, after: string): Splice | null`, `type Splice = { start: number; end: number; text: string }`
  - `type TextView = { getValue(): string; applyOutside(splice: Splice): void; onUserChange(listener: () => void): { dispose(): void } }`
  - `bindDocument(view: TextView, options?: { onConflicts?(count: number): void }): Promise<{ readOnly: boolean; initial: string; dispose(): void }>` — opens `orca.document.session<string>({ merge })` itself, where `merge` calls `mergeText` and reports `conflicts > 0` through `onConflicts`. It forwards user changes with `session.change(view.getValue())` and applies `onReplace` text with `smallestEdit` + `view.applyOutside` (never echoing an applied outside change back as a user change).

Merge policy (decided here): line-based `diff3Merge` from `node-diff3` with `excludeFalseConflicts: true`, on line arrays that keep their terminators (`text.split(/(?<=\n)/)`), argument order `(mine, base, outside)`. Non-overlapping changes from both sides are both kept. Each overlapping region is written as:

```
<<<<<<< your unsaved edits
<mine lines>
=======
<file on disk lines>
>>>>>>> file on disk
```
with a `\n` added after any side that does not end in one. Nothing is ever dropped; PHPantom then flags the markers as syntax errors and the note (Task 4) says what happened.

- [ ] **Step 1: Write the failing merge tests**

```ts
test('takes the outside text when only the file changed', () => {
  assert.deepEqual(mergeText('a\nb\n', 'a\nB\n', 'a\nb\n'), { text: 'a\nB\n', conflicts: 0 })
})
test('keeps both when they touch different lines', () => {
  assert.deepEqual(mergeText('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n'), { text: 'A\nb\nC\n', conflicts: 0 })
})
test('keeps both sides when an agent rewrites the lines being edited', () => {
  assert.deepEqual(mergeText('a\nb\nc\n', 'a\nB2\nc\n', 'a\nB1\nc\n'), {
    text: 'a\n<<<<<<< your unsaved edits\nB1\n=======\nB2\n>>>>>>> file on disk\nc\n', conflicts: 1
  })
})
test('treats the same change on both sides as no conflict', () => {
  assert.deepEqual(mergeText('a\n', 'b\n', 'b\n'), { text: 'b\n', conflicts: 0 })
})
test('merges a 1 MB file well inside the 1 s answer budget', () => {
  const base = Array.from({ length: 30_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}\n`).join('')
  const mine = base.replace('line 10 ', 'line ten ')
  const outside = base.replace('line 29000 ', 'line 29k ')
  const started = performance.now()
  const merged = mergeText(base, outside, mine)
  assert.ok(performance.now() - started < 400)
  assert.equal(merged.conflicts, 0)
  assert.ok(merged.text.includes('line ten ') && merged.text.includes('line 29k '))
})
```

- [ ] **Step 2: Run, see them fail** — `orca plugin test .`, Expected: FAIL, `Cannot find module './merge.ts'`.
- [ ] **Step 3: Implement `mergeText`** in `editor/src/merge.ts` per the policy above.
- [ ] **Step 4: Run, see them pass** — `orca plugin test .`, Expected: the merge tests PASS.
- [ ] **Step 5: Vendor `edits.ts` and its test** (copy `editor/src/edits.ts` and `editor/src/edits.test.ts` at `da5a680`, keep `smallestEdit` and `Splice`, drop `contextAround`, add the header). Run `orca plugin test .`; Expected: PASS.
- [ ] **Step 6: Write the failing sync tests** (`editor/src/sync.test.ts`), using `mockEditorHost` and a fake `TextView` over a string:

```ts
test('sends a user edit and saves it', async () => {
  const host = mockEditorHost({ text: '<?php\n' })
  const view = fakeView()
  const doc = await bindDocument(view)
  view.type('<?php\necho 1;\n')
  await host.flush()
  assert.equal(host.text, '<?php\necho 1;\n')
  doc.dispose(); host.dispose()
})
test('applies an outside write without echoing it back', async () => {
  const host = mockEditorHost({ text: 'a\n' })
  const view = fakeView()
  await bindDocument(view)
  host.replace('a\nb\n')
  await settle()
  assert.equal(view.getValue(), 'a\nb\n')
  assert.equal(host.edits.length, 0)
  host.dispose()
})
test('keeps the draft when an agent writes during unsaved edits', async () => {
  const host = mockEditorHost({ text: 'a\nb\nc\n' })
  const view = fakeView()
  let conflicts = 0
  await bindDocument(view, { onConflicts: (n) => (conflicts = n) })
  view.type('a\nB1\nc\n')
  host.conflictNext('a\nB2\nc\n')
  await host.flush()
  assert.equal(host.text, 'a\n<<<<<<< your unsaved edits\nB1\n=======\nB2\n>>>>>>> file on disk\nc\n')
  assert.equal(conflicts, 1)
  host.dispose()
})
test('reports read-only documents', async () => {
  const host = mockEditorHost({ text: 'x' }, { readOnly: true })
  assert.equal((await bindDocument(fakeView())).readOnly, true)
  host.dispose()
})
```
`fakeView()` and `settle()` are test helpers in the same file: a string-backed `TextView` whose `type(text)` replaces the value and fires user-change listeners, and a `setTimeout(…, 300)` wait past the 250 ms session debounce.

- [ ] **Step 7: Run, see them fail** — Expected: FAIL, `Cannot find module './sync.ts'`.
- [ ] **Step 8: Implement `bindDocument`** in `editor/src/sync.ts`.
- [ ] **Step 9: Run, see them pass** — `orca plugin test .`, Expected: all PASS.
- [ ] **Step 10: Commit**

```bash
git add editor/src/merge.ts editor/src/merge.test.ts editor/src/edits.ts editor/src/edits.test.ts editor/src/sync.ts editor/src/sync.test.ts package.json package-lock.json
git commit -m "feat(editor): sync the document with Orca and merge outside writes without losing edits"
```

---

### Task 4: Editor shell: Monaco bundle, pages, Blade grammar, theme, notes

**Files:**
- Create: `editor/build.mjs`, `editor/pages/php.html`, `editor/pages/blade.html` (replace the Task 2 stubs), `editor/src/main.ts`, `editor/src/editor.ts`, `editor/src/editor.worker.ts`, `editor/src/monaco.ts`, `editor/src/blade.ts`, `editor/src/blade.test.ts`, `editor/src/theme.ts`, `editor/src/theme.test.ts`, `editor/src/notes.ts`, `editor/src/env.d.ts`, `editor/src/monaco-modules.d.ts`, `editor/dist/**`
- Modify: `.github/workflows/ci.yml` (add the build reproducibility line)

**Interfaces:**
- Consumes: `bindDocument`, `Splice` (Task 3).
- Produces:
  - Pages set `window.__PHPANTOM_LANGUAGE__ = 'php' | 'blade'` then load `../dist/main.js` (module) and `../dist/main.css`.
  - `bladeGrammar(html: { conf: object; language: MonarchLanguage }): { conf: object; language: MonarchLanguage }` (pure, does not import Monaco)
  - `SEMANTIC_TYPES: readonly string[]` (the 15 legend types), `SEMANTIC_MODIFIERS: readonly string[]` (the 7 legend modifiers, in legend order), `themeColors(vars: Record<string, string>): Record<string, string>`, `themeRules(dark: boolean): { token: string; foreground?: string; fontStyle?: string }[]`, `THEME_NAME = { dark: 'phpantom-dark', light: 'phpantom-light' }`, `defineThemes(monaco): void`, `typographyOptions(t: EditorTypography): Partial<EditorOptions>` where `EditorTypography` is the `editor.readTypography` result type.
  - `showNote(kind: 'info' | 'warning', text: string, key: string): void`, `clearNote(key: string): void` in `editor/src/notes.ts`.
  - `startEditor(): Promise<EditorContext>` in `editor/src/editor.ts`, with `type EditorContext = { monaco: typeof Monaco; editor: Monaco.editor.IStandaloneCodeEditor; model: Monaco.editor.ITextModel; docId: string; language: Language }`. It creates the model with language `php` or `blade` and URI `inmemory://phpantom/<docId>.<language>` (`docId` is `crypto.randomUUID()`), creates the editor and binds the document.
  - `editor/src/main.ts` is the bundle entry and only calls `startEditor()` (Task 10 adds `attachLanguageServer(ctx)`); on a startup error it shows the message in the page, as Autocomplete's `main.ts` does.

Build (`editor/build.mjs`): esbuild, `bundle: true`, `format: 'esm'`, `target: 'es2022'`, `loader: { '.ttf': 'dataurl' }`, `minify: true`, `logLevel: 'warning'`; entry `main` from `editor/src/main.ts` with `splitting: true`, `chunkNames: 'chunks/[name]-[hash]'`; a second build for `editor.worker` from a one-line `editor/src/editor.worker.ts` that imports `monaco-editor/editor/editor.worker`. `rmSync(editor/dist)` first; print total size and file count; fail if any file exceeds 10 MiB or the count exceeds 200. `MonacoEnvironment.getWorker` returns `new Worker(new URL('./editor.worker.js', import.meta.url), { type: 'module' })`.

Monaco imports (`editor/src/monaco.ts`): `monaco-editor/editor`, `monaco-editor/features/register.all`, `monaco-editor/languages/definitions/php/register`, `monaco-editor/languages/definitions/html/register`, and `{ conf, language }` from `monaco-editor/languages/definitions/html/html` (declared in `monaco-modules.d.ts`). Register language id `blade` with `bladeGrammar({ conf, language })`.

Blade grammar (decided here): a deep copy of HTML's Monarch definition with these rules prepended to `root` and to every tag and attribute-value state: `{{--` … `--}}` → `comment.blade`; `{!!` … `!!}` and `{{` … `}}` → delimiters `delimiter.blade`, contents tokenized by a small `bladeExpression` state (`$name` → `variable`, quoted strings → `string`, numbers → `number`, `->`, `::`, `=>` → `delimiter`, PHP keywords `fn function new return true false null and or not instanceof` → `keyword`, identifiers → `identifier`); `@` + identifier (not preceded by a word character or `@@`) → `keyword.blade`, followed optionally by a balanced `(` … `)` tokenized by `bladeExpression`; `@verbatim` … `@endverbatim` passes contents through as plain HTML text; `<x-` / `</x-` component tags → `tag.blade` with their attributes handled like HTML attributes, and `:attr="…"` values tokenized by `bladeExpression`. `@php` … `@endphp` contents use `bladeExpression`.

Theme (decided here): `phpantom-dark` (base `vs-dark`) and `phpantom-light` (base `vs`), `inherit: true`, a rule for every `SEMANTIC_TYPES` entry with a colour taken from the base theme's colour for the nearest Monarch token (`variable`/`parameter` → the base's `variable` colour, `class`/`interface`/`enum`/`type`/`typeParameter`/`namespace` → `type`, `function`/`method` → the base's function colour, `property`/`enumMember` → `variable`, `keyword` → `keyword`, `comment` → `comment`, `decorator` → `annotation`), plus modifier rules. Monaco matches a semantic token as `type.mod1.mod2…` (modifiers in legend order) against theme rules by dot-separated prefix, with no wildcard, so `themeRules` generates, for every type, one rule per non-empty subset of the 7 legend modifiers joined in legend order (15 × 127 rules), with `fontStyle` `italic` when the subset has `static`, `strikethrough` when it has `deprecated`, both joined by a space when it has both, and the type's colour. Editor chrome follows Orca's frame variables: `themeColors(vars: Record<string, string>): Record<string, string>` (pure, values already `#rrggbb`) maps `--orca-background` → `editor.background`, `editorGutter.background`, `minimap.background`; `--orca-foreground` → `editor.foreground`; `--orca-popover` / `--orca-popover-foreground` → `editorWidget.background`, `editorHoverWidget.background`, `editorSuggestWidget.background` and their `.foreground`; `--orca-border` → `editorWidget.border`, `editorHoverWidget.border`, `editorSuggestWidget.border`; `--orca-ring` → `focusBorder`; `--orca-muted-foreground` → `editorLineNumber.foreground`; missing variables are left out so the base theme's colour stays. `readOrcaVars()` (glue, not unit-tested) reads them with `getComputedStyle(document.documentElement)` and converts any CSS colour to hex by filling a 1×1 canvas and reading the pixel; `defineThemes` runs again on each `theme` event. Editor options: `'semanticHighlighting.enabled': true`, Orca's native options from Autocomplete's `NATIVE_OPTIONS` (copy the values, not the file), `quickSuggestions: true`, `fixedOverflowWidgets: true`, and `typographyOptions(await orca.host.call('editor.readTypography', {}))`, re-applied on `orca.on('editor.typography.changed', …)`. Theme follows `orca.on('theme', …)` and the `dark` class on `<html>`.

- [ ] **Step 1: Write the failing grammar and theme tests**

```ts
// blade.test.ts — run the Monarch rules' regexes over sample lines; no Monaco import.
test('keeps every HTML state and puts Blade rules first in root', () => {
  const g = bladeGrammar(fakeHtml())
  for (const state of Object.keys(fakeHtml().language.tokenizer)) assert.ok(state in g.language.tokenizer)
  assert.match('{{ $user->name }}', firstRuleRegex(g, 'root'))
})
test('tokenizes the Blade constructs', () => {
  assert.deepEqual(tokenTypes(bladeGrammar(fakeHtml()), "@if($a) {{-- note --}} {!! $b !!} <x-alert :user=\"$u\" />"),
    ['keyword.blade', 'delimiter.parenthesis', 'variable', 'delimiter.parenthesis', 'comment.blade', 'delimiter.blade', 'variable', 'delimiter.blade', 'tag.blade', 'attribute.name', 'variable'])
})
test('does not treat an email address as a directive', () => {
  assert.ok(!tokenTypes(bladeGrammar(fakeHtml()), 'mail me@example.com').includes('keyword.blade'))
})
// theme.test.ts
test('every semantic token type has a rule in both themes', () => {
  for (const dark of [true, false]) {
    const tokens = new Set(themeRules(dark).map((r) => r.token))
    for (const type of SEMANTIC_TYPES) assert.ok(tokens.has(type), `${type} (${dark ? 'dark' : 'light'})`)
  }
})
test('modifier combinations get exact rules', () => {
  const byToken = new Map(themeRules(true).map((r) => [r.token, r]))
  assert.equal(byToken.get('method.deprecated')?.fontStyle, 'strikethrough')
  assert.equal(byToken.get('method.static.deprecated')?.fontStyle, 'italic strikethrough')
  assert.equal(byToken.get('method.declaration.static')?.fontStyle, 'italic')
  assert.equal(byToken.get('parameter.declaration')?.fontStyle, undefined)
})
test('maps Orca frame variables to editor colours and skips missing ones', () => {
  assert.deepEqual(themeColors({ '--orca-background': '#101010', '--orca-foreground': '#eeeeee' }),
    { 'editor.background': '#101010', 'editorGutter.background': '#101010', 'minimap.background': '#101010', 'editor.foreground': '#eeeeee' })
})
test('maps Orca typography to Monaco options', () => {
  assert.deepEqual(typographyOptions({ fontFamily: 'JetBrains Mono', cssFontFamily: '"JetBrains Mono", monospace', fontSize: 14, fontWeight: '400', lineHeight: 20, fontLigatures: true, wordWrap: 'off', minimap: false }),
    { fontFamily: '"JetBrains Mono", monospace', fontSize: 14, fontWeight: '400', lineHeight: 20, fontLigatures: true, wordWrap: 'off', minimap: { enabled: false } })
})
```
`fakeHtml()` is a minimal stand-in with `root`, `tag`, `attributeValue` states; `tokenTypes` is a small test-only Monarch walker over the rules (match at position, first rule wins, follow `next`), written once in `editor/src/monarch-walk.test-helper.ts`.

- [ ] **Step 2: Run, see them fail** — Expected: FAIL, missing modules.
- [ ] **Step 3: Implement `blade.ts` and `theme.ts`.**
- [ ] **Step 4: Run, see them pass** — `orca plugin test .`.
- [ ] **Step 5: Implement `monaco.ts`, `notes.ts`, `editor.ts`, `main.ts`, the pages and `build.mjs`**; `startEditor` binds the model through Task 3's `bindDocument` (its `TextView` wraps the model: `applyOutside` uses `model.pushEditOperations` so undo survives, `onUserChange` is `model.onDidChangeContent` filtered by an `applying` flag), shows `showNote('warning', '…', 'conflict')` with the text `An outside change overlapped your unsaved edits. Both versions are in the file between <<<<<<< and >>>>>>> markers.` when `onConflicts` fires, and sets `readOnly`.
- [ ] **Step 6: Build and check**

Run: `npm ci && node editor/build.mjs && orca plugin check .`
Expected: build prints about 4.5 MB in under 20 files; `orca plugin check` exits 0 with no `editor_*` failures.

- [ ] **Step 7: Look at it**

Run: `orca plugin dev load . --approve <fingerprint>`, then `orca plugin shot . --editor <repo>/app/Models/User.php --theme dark` and the same for a `.blade.php` file and with `--theme light`.
Expected: Monaco with PHP and Blade colouring, Orca's font, no error in the shot's `errors`. Read the PNGs.

- [ ] **Step 8: Reproducibility** — run `node editor/build.mjs && git status --short editor/dist`; Expected: no changes on the second build. Add the CI line `node editor/build.mjs && git diff --exit-code -- editor/dist`.
- [ ] **Step 9: Commit**

```bash
git add editor .github/workflows/ci.yml package.json package-lock.json
git commit -m "feat(editor): Monaco editor for PHP and Blade that follows Orca's theme and typography"
```

---

### Task 5: Binary resolver

**Files:**
- Create: `src/binary/release.ts`, `src/binary/find.ts`, `src/binary/extract.ts`, `src/binary/download.ts`, `src/binary/resolve.ts`, and tests `src/binary/*.test.ts`, fixtures `src/binary/fixtures/one.tar.gz`, `src/binary/fixtures/one.zip`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PHPANTOM_VERSION = '1.1.0'`; `type ReleaseAsset = { asset: string; sha256: string; member: 'phpantom_lsp' | 'phpantom_lsp.exe'; kind: 'tar.gz' | 'zip' }`; `assetFor(platform: string, arch: string): ReleaseAsset | null` (the Global Constraints table); `downloadUrl(asset: ReleaseAsset): string`.
  - `findExecutable(command: string, env?, platform?, exists?): string | null` (vendored from `src/lsp/servers.ts`), `wellKnownDirs(env: NodeJS.ProcessEnv, platform: string): string[]` (`/opt/homebrew/bin`, `/usr/local/bin`, `$HOME/.cargo/bin`; on Windows `%USERPROFILE%\.cargo\bin`), `parseVersion(output: string): string | null` (from `phpantom_lsp X.Y.Z`), `atLeast(version: string, minimum: string): boolean`, `readVersion(path: string, timeoutMs?: number): Promise<string | null>` (runs `<path> --version`, 5 s default).
  - `extractSingleFile(archive: Buffer, kind: 'tar.gz' | 'zip', member: string): Buffer` — Node builtins only: `zlib.gunzipSync` plus a ustar header walk (name at 0..100, octal size at 124..136, type flag at 156, 512-byte blocks) for tar; End of Central Directory (`0x06054b50`), central directory entries (`0x02014b50`) and the local header (`0x04034b50`) with method 0 (stored) or 8 (`zlib.inflateRawSync`) for zip. Throws `Error('archive has no <member>')` when absent.
  - `downloadVerified(url: string, sha256: string, fetchImpl?: typeof fetch): Promise<Buffer>` — streams, hashes, throws `Error('checksum mismatch for <url>')` on a wrong hash or `Error('download failed: HTTP <status>')`.
  - `cacheDir(env: NodeJS.ProcessEnv, platform: string, home: string): string` — macOS `~/Library/Caches/noppu-labs.phpantom`, Linux `${XDG_CACHE_HOME:-~/.cache}/noppu-labs.phpantom`, Windows `%LOCALAPPDATA%\noppu-labs.phpantom\cache`.
  - `type Resolution = { ok: true; path: string; version: string; source: 'setting' | 'path' | 'cache' | 'download' } | { ok: false; message: string }`
  - `resolveBinary(options: { settingPath: string; allowDownload: boolean; env: NodeJS.ProcessEnv; platform: string; arch: string; home: string; onDownload?(): void; fetchImpl?: typeof fetch; readVersionImpl?: typeof readVersion }): Promise<Resolution>`

Resolution order (decided here where the spec was silent):
1. `settingPath` non-empty: use it if it exists and `readVersion` answers; otherwise fail with `phpantomPath is set to <path>, which is not a working phpantom_lsp.` (no silent fallback past an explicit setting).
2. `findExecutable('phpantom_lsp')` on `PATH`, then the same name in `wellKnownDirs` (a Dock-launched app may lack Homebrew on `PATH`): use the first whose version is at least `1.1.0`.
3. `<cacheDir>/1.1.0/<platform>-<arch>/<member>` when present together with a `verified` marker file written after a checked download.
4. `allowDownload`: call `onDownload`, download, verify, extract to `<member>.tmp`, `chmod 0o755`, rename into place, write `verified`; one download at a time per process (share the promise).
5. Otherwise fail with `PHPantom 1.1.0 or newer was not found. Install it (brew install phpantom-lsp) or turn on "Download PHPantom when missing".` An unsupported platform fails with `PHPantom has no build for <platform>-<arch>.`

- [ ] **Step 1: Make the fixtures**

```bash
d=$(mktemp -d) && printf 'fake-binary' > "$d/phpantom_lsp" && printf 'fake-exe' > "$d/phpantom_lsp.exe"
COPYFILE_DISABLE=1 tar -C "$d" -czf src/binary/fixtures/one.tar.gz phpantom_lsp
(cd "$d" && zip -q -X one.zip phpantom_lsp.exe) && mv "$d/one.zip" src/binary/fixtures/one.zip
```

- [ ] **Step 2: Write the failing tests**

```ts
test('maps all six platforms and nothing else', () => {
  assert.equal(assetFor('darwin', 'arm64')?.asset, 'phpantom_lsp-aarch64-apple-darwin.tar.gz')
  assert.equal(assetFor('win32', 'x64')?.sha256, '9b5b93400171881517a36dc34ac330db733399a6faaec7e88eec18d3189d11bd')
  assert.equal(assetFor('linux', 'ia32'), null)
})
test('extracts the one file from each archive kind', () => {
  assert.equal(extractSingleFile(readFileSync(fixture('one.tar.gz')), 'tar.gz', 'phpantom_lsp').toString(), 'fake-binary')
  assert.equal(extractSingleFile(readFileSync(fixture('one.zip')), 'zip', 'phpantom_lsp.exe').toString(), 'fake-exe')
  assert.throws(() => extractSingleFile(readFileSync(fixture('one.zip')), 'zip', 'other'), /archive has no other/)
})
test('reads and compares versions', () => {
  assert.equal(parseVersion('phpantom_lsp 1.1.0\n'), '1.1.0')
  assert.ok(atLeast('1.1.0', '1.1.0') && atLeast('1.10.0', '1.9.9') && !atLeast('1.0.9', '1.1.0'))
})
test('rejects a download whose hash differs', async () => {
  await withServer(Buffer.from('tampered'), async (url) => {
    await assert.rejects(downloadVerified(url, '0'.repeat(64)), /checksum mismatch/)
  })
})
test('an explicit setting that does not work is an error, not a fallback', async () => {
  const r = await resolveBinary({ ...base(), settingPath: '/nope/phpantom_lsp' })
  assert.deepEqual(r, { ok: false, message: 'phpantomPath is set to /nope/phpantom_lsp, which is not a working phpantom_lsp.' })
})
test('skips an old PATH binary and downloads when allowed', async () => { /* fake PATH dir holding a script that prints "phpantom_lsp 1.0.0"; fetchImpl serves one.tar.gz with its real hash patched into a test asset table via the readVersionImpl/fetchImpl seams; expect source 'download' and a verified marker */ })
test('uses the cache without downloading again', async () => { /* second resolve with fetchImpl that throws; expect source 'cache' */ })
test('says how to install when downloads are off', async () => { /* allowDownload false, empty PATH: expect the step 5 message */ })
```
For the download tests, `resolveBinary` takes an optional `assets?: (platform, arch) => ReleaseAsset | null` seam so the test can point at the fixture with its real SHA-256 (computed in the test with `createHash`). `withServer` is a `node:http` server on port 0 in the test file.

- [ ] **Step 3: Run, see them fail.** `orca plugin test .` → FAIL, missing modules.
- [ ] **Step 4: Implement the five modules.**
- [ ] **Step 5: Run, see them pass.** `orca plugin test .` → PASS.
- [ ] **Step 6: Opt-in real download check**

Run: `PHPANTOM_INTEGRATION=1 orca plugin test .` with a test (skipped unless that variable is set) that resolves with an empty `PATH` and a temp `home`, then runs the result with `--version`.
Expected: `phpantom_lsp 1.1.0`, `source: 'download'`. Add this as a separate CI step with `PHPANTOM_INTEGRATION=1` (it downloads about 22 MB on linux-x64).

- [ ] **Step 7: Commit**

```bash
git add src/binary
git commit -m "feat(worker): find, download and verify the pinned PHPantom binary"
```

---

### Task 6: JSON-RPC transport and the PHPantom process

**Files:**
- Create: `src/lsp/jsonrpc.ts` (vendored), `src/lsp/jsonrpc.test.ts` (vendored), `src/lsp/uri.ts` (vendored), `src/lsp/uri.test.ts` (vendored), `src/lsp/capabilities.ts`, `src/lsp/server.ts`, `src/lsp/server.test.ts`, `src/lsp/fixtures/fake-server.mjs`

**Interfaces:**
- Consumes: nothing (Task 9 passes it the binary path from Task 5).
- Produces:
  - `RpcConnection` (vendored) with one added parameter: `request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>`; on abort it sends `$/cancelRequest { id }`, rejects with `Error('cancelled')`, and ignores the late answer.
  - `uriKey`, `sameUri` (vendored).
  - `CLIENT_CAPABILITIES` — Autocomplete's set plus: `general.positionEncodings ['utf-16']`; `window.workDoneProgress: true`; `workspace.semanticTokens.refreshSupport`, `workspace.inlayHint.refreshSupport`, `workspace.workspaceEdit.documentChanges: true`, `workspace.applyEdit: false`, `workspace.configuration: true`; `textDocument.synchronization.didSave: false`; `textDocument.codeAction.resolveSupport.properties ['edit']`, `dataSupport: true`, `isPreferredSupport: true`; `textDocument.semanticTokens { requests: { full: true }, formats: ['relative'], tokenTypes: <the 15 legend types>, tokenModifiers: <the 7 legend modifiers> }`; `textDocument.inlayHint { resolveSupport: { properties: ['tooltip'] } }`; `textDocument.definition.linkSupport: false`; `textDocument.publishDiagnostics { tagSupport: { valueSet: [1, 2] } }`. It must not contain `textDocument.diagnostic`.
  - `type ServerEvents = { diagnostics(uri: string, diagnostics: unknown[]): void; progress(state: ServerState): void; refresh(kind: 'semanticTokens' | 'inlayHints' | 'codeLens' | 'diagnostics'): void; log(message: string): void; exit(reason: string): void }` (`ServerState` from Task 2's `src/status.ts`)
  - `class PhpantomServer { constructor(options: { executable: string; root: string; events: ServerEvents; spawnImpl?: typeof spawn; initializeTimeoutMs?: number }); start(): Promise<void>; readonly capabilities: Record<string, unknown>; readonly alive: boolean; notify(method: string, params: unknown): void; request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>; stop(): Promise<void> }`

Behaviour: spawn `<executable> --stdio` with `cwd: root`, `windowsHide: true`, `stdio: ['pipe','pipe','pipe']`; `initialize` with `processId: process.pid`, `clientInfo { name: 'orca-phpantom', version: '0.1.0' }`, `rootUri` and one `workspaceFolders` entry for `root`, `CLIENT_CAPABILITIES`; 60 s initialize timeout (cold index of a large project); then `initialized`. Server requests: `workspace/configuration` → `items.map(() => null)`; `window/workDoneProgress/create`, `client/registerCapability`, `client/unregisterCapability` → `null`; `workspace/{semanticTokens,inlayHint,codeLens,diagnostic}/refresh` → `null` and `events.refresh(kind)`; `workspace/applyEdit` → `{ applied: false }`; anything else → `null`. Notifications: `textDocument/publishDiagnostics` → `events.diagnostics`; `$/progress` begin/report/end → `events.progress({ phase: 'indexing', percent })` and `{ phase: 'ready' }` when the last open token ends (right after `initialized` the state is `ready` unless a token is open); `window/logMessage` with type 1 or 2 → `events.log`. Keep the last 8 stderr lines for the exit message (as Autocomplete does). `stop()` sends `shutdown` (2 s cap), `exit`, closes stdin, and kills after 2 s more.

`fake-server.mjs` is plain JavaScript with its own framing (so `process.execPath` runs it without TypeScript): it answers `initialize` with `{ capabilities: { textDocumentSync: 2, hoverProvider: true, definitionProvider: true, semanticTokensProvider: { legend: { tokenTypes: ['parameter'], tokenModifiers: [] }, full: true } } }`, applies incremental `didChange` to its own copy, publishes one diagnostic per occurrence of `BAD`, answers hover with `len=<document length>`, sends `$/progress` begin/end around a fake index, sends `workspace/inlayHint/refresh` after `initialized`, and exits on `exit`, on stdin end, or when the document contains `CRASH`.

- [ ] **Step 1: Vendor `jsonrpc.ts`, `uri.ts` and their tests** (copy at `da5a680`, add headers). Run `orca plugin test .`; Expected: vendored tests PASS.
- [ ] **Step 2: Write the failing tests** (`src/lsp/jsonrpc.test.ts` additions and `src/lsp/server.test.ts`)

```ts
test('cancelling a request sends $/cancelRequest and rejects', async () => { /* pair two RpcConnections in memory; abort; expect the peer to receive {method:'$/cancelRequest', params:{id:1}} and the promise to reject /cancelled/ */ })
test('starts, initializes and reports capabilities', async () => {
  const s = fakeServer(); await s.start()
  assert.equal((s.capabilities as any).hoverProvider, true); await s.stop()
})
test('forwards diagnostics, progress and refresh', async () => {
  const s = fakeServer(); await s.start()
  s.notify('textDocument/didOpen', { textDocument: { uri: 'file:///w/a.php', languageId: 'php', version: 1, text: '<?php BAD' } })
  await until(() => events.diagnostics.length > 0 && events.refresh.includes('inlayHints') && events.progress.at(-1)?.phase === 'ready')
  await s.stop()
})
test('answers configuration with one null per item', async () => { /* fake server option makes it request workspace/configuration with 3 items; expect [null,null,null] */ })
test('reports an exit with the stderr tail', async () => { /* open a CRASH document; expect events.exit called once and alive false; a later request rejects */ })
test('client capabilities never ask for pull diagnostics', () => {
  assert.equal((CLIENT_CAPABILITIES.textDocument as any).diagnostic, undefined)
})
```

- [ ] **Step 3: Run, see them fail.** Expected: FAIL, missing `server.ts`, `capabilities.ts`, and the cancel test.
- [ ] **Step 4: Implement** `capabilities.ts`, `server.ts`, the cancellation addition and the fixture.
- [ ] **Step 5: Run, see them pass.** `orca plugin test .` → PASS.
- [ ] **Step 6: Commit**

```bash
git add src/lsp THIRD_PARTY_NOTICES.md
git commit -m "feat(worker): run PHPantom over stdio with progress, refresh and crash reporting"
```

---

### Task 7: Change splitting and the worker's document mirror

**Files:**
- Create: `editor/src/split.ts`, `editor/src/split.test.ts`, `src/lsp/mirror.ts`, `src/lsp/mirror.test.ts`

**Interfaces:**
- Consumes: `LspContentChange`, `LspRange` (Task 2 protocol).
- Produces:
  - `REQUEST_BUDGET_BYTES = 56 * 1024` (64 KiB minus room for the envelope)
  - `encodedSize(value: unknown): number` — UTF-8 bytes of `JSON.stringify(value)`
  - `chunkText(text: string, budget?: number): string[]` — consecutive pieces, each with `encodedSize(piece) <= budget`, never splitting a surrogate pair; `''` gives `['']`
  - `splitChanges(changes: LspContentChange[], budget?: number): LspContentChange[][]` — groups in the original order, each group's `encodedSize` within budget
  - `class DocumentMirror { constructor(text: string); readonly text: string; readonly length: number; version: number; apply(changes: LspContentChange[]): void }` — UTF-16 offsets, `\r\n`, `\r` and `\n` all end a line

Splitting algorithm (not determined by the signature): pack whole changes into the current group while it fits. A change whose own text does not fit is cut with `chunkText`; its first piece replaces the original range, and each following piece is an insertion (an empty range) at the end position of the text inserted so far: the line advances by the number of line breaks in the inserted text, and the character is the UTF-16 length after the last break (or the start character plus the piece's length when there is no break).

- [ ] **Step 1: Write the failing tests**

```ts
test('small changes stay in one group', () => { assert.equal(splitChanges([ins(0, 0, 'a'), ins(0, 1, 'b')]).length, 1) })
test('split changes rebuild the same text', () => {
  const base = 'x\n'.repeat(1000)
  const big = 'é😀\r\n"quote" \\ tab\t'.repeat(9000)            // well over 64 KiB once JSON-encoded
  const change = { range: { start: { line: 3, character: 0 }, end: { line: 5, character: 1 } }, text: big }
  const expected = new DocumentMirror(base); expected.apply([change])
  const actual = new DocumentMirror(base)
  const groups = splitChanges([change])
  assert.ok(groups.length > 1)
  for (const group of groups) { assert.ok(encodedSize(group) <= REQUEST_BUDGET_BYTES); actual.apply(group) }
  assert.equal(actual.text, expected.text)
})
test('never splits a surrogate pair', () => { for (const piece of chunkText('😀'.repeat(40_000), 1024)) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(piece)) })
test('mirror applies changes in the order Monaco sends them', () => {
  const m = new DocumentMirror('abc\ndef\n')
  m.apply([ins(1, 3, '!'), ins(0, 0, '>')])                    // end-first, as Monaco orders them
  assert.equal(m.text, '>abc\ndef!\n')
})
test('a full-text change replaces everything', () => { const m = new DocumentMirror('a'); m.apply([{ text: 'b' }]); assert.equal(m.text, 'b') })
test('handles CRLF line ends', () => { const m = new DocumentMirror('a\r\nb'); m.apply([ins(1, 1, 'c')]); assert.equal(m.text, 'a\r\nbc') })
```
`ins(line, character, text)` builds an insertion at an empty range. The router tests in Task 9 cover `a gap in versions asks for a resync`.

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement `split.ts` and `mirror.ts`.**
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit**

```bash
git add editor/src/split.ts editor/src/split.test.ts src/lsp/mirror.ts src/lsp/mirror.test.ts
git commit -m "feat: split large changes across requests and mirror documents in the worker"
```

---

### Task 8: File locator and workspace roots

**Files:**
- Create: `src/locate/locate.ts` (adapted from `src/lsp/locate.ts`), `src/locate/locate.test.ts`, `src/locate/workspaces.ts`, `src/locate/workspaces.test.ts`

**Interfaces:**
- Consumes: Task 1 report (how ids map); `Language` (Task 2).
- Produces:
  - `type WorkspaceRow = { id: string; name: string; branch: string | null; path: string; hostId: string | null }` (the fields of `workspace.list` rows used here)
  - `isLocal(row: WorkspaceRow): boolean` — `hostId` is `'local'` or `null`, and `path` does not start with `\\wsl.localhost\`, `\\wsl$\` or `//wsl.localhost/` (case-insensitive)
  - `resolveFocused(rows: WorkspaceRow[], workspaceId: string | null, context?: { branch: string; displayName: string }): WorkspaceRow | null` — by `id`, else by `branch` and `name === displayName` (kept whatever Task 1 found; it costs nothing)
  - `composerRoot(filePath: string, workspacePath: string, exists?: (path: string) => boolean): string` — the nearest folder at or above the file, and at or below the workspace, holding `composer.json`; the workspace path when none
  - `workspaceFor(filePath: string, rows: WorkspaceRow[]): WorkspaceRow | null` — the local row with the longest path that contains the file
  - `type Located = { status: 'found'; path: string; root: string; approximate?: true } | { status: 'none' } | { status: 'ambiguous' }`
  - `locateFile(input: { tiers: string[][]; candidates: string[]; language: Language; content: string }, options?: { maxFiles?: number; budgetMs?: number; alikeBudgetMs?: number }): Promise<Located>`

Changes from the vendored locator: (1) `candidates` (pending reveal paths) are checked first, exact content then likeness, before any walk; a candidate match returns its root as the workspace path it lies in (`root` is filled in by the caller). (2) `tiers` are searched in order; `found` or `ambiguous` in a tier ends the search, `none` moves to the next tier (tier 0 is the focused workspace, tier 1 every other local workspace). (3) A `blade` document matches only names ending `.blade.php`; a `php` document only `.php` names that do not end `.blade.php`. (4) Add `storage` to the skipped folders; keep `vendor` skipped (navigation into vendor works through `candidates`). Everything else (breadth-first walk, BOM tolerance, `sharedLines` likeness, budgets) stays as vendored.

- [ ] **Step 1: Write the failing tests** (temp folders built in the test)

```ts
test('prefers the focused worktree when both copies match', async () => {
  const [a, b] = await twoWorktrees({ 'app/Example.php': '<?php class Example {}\n' })
  assert.deepEqual(await locateFile({ tiers: [[b], [a]], candidates: [], language: 'php', content: '<?php class Example {}\n' }),
    { status: 'found', path: join(b, 'app/Example.php'), root: b })
})
test('two identical files inside the focused workspace are ambiguous and do not fall through', async () => { /* a/x.php and a/y.php same content, b has a unique match: expect ambiguous */ })
test('nothing in the focused workspace falls through to the others', async () => { /* expect found in tier 1 */ })
test('a pending reveal path wins even inside vendor', async () => { /* file under a/vendor/...; candidates [that path]; expect found */ })
test('blade and php documents never match each other', async () => { /* same text in welcome.blade.php and welcome.php */ })
test('an edited document is found by likeness', async () => { /* 20-line file, 2 lines changed: expect approximate: true */ })
test('maps the focused workspace by id, then by branch and name', () => { /* resolveFocused cases */ })
test('remote and WSL workspaces are not local', () => {
  assert.equal(isLocal({ id: '1', name: 'x', branch: null, path: '/srv/app', hostId: 'ssh:box' }), false)
  assert.equal(isLocal({ id: '2', name: 'x', branch: null, path: '\\\\wsl.localhost\\Ubuntu\\app', hostId: 'local' }), false)
  assert.equal(isLocal({ id: '3', name: 'x', branch: null, path: '/Users/me/app', hostId: null }), true)
})
test('the composer root is the nearest composer.json inside the workspace', () => { /* packages/api/composer.json and composer.json at root: file under packages/api resolves there; a file with none resolves to the workspace path */ })
```

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Copy `src/lsp/locate.ts` at `da5a680` into `src/locate/locate.ts`, add the header, apply changes (1)–(4); write `workspaces.ts`.**
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit**

```bash
git add src/locate
git commit -m "feat(worker): locate the open file, focused worktree first"
```

---

### Task 9: Worker router, server pool, posts and status

**Files:**
- Create: `src/router.ts`, `src/router.test.ts`, `src/outbox.ts`, `src/outbox.test.ts`, `src/reveals.ts`, `src/reveals.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: Task 2 protocol and status; Task 5 `resolveBinary`; Task 6 `PhpantomServer`, `ServerEvents`, `sameUri`; Task 7 `DocumentMirror`; Task 8 `locateFile`, `resolveFocused`, `isLocal`, `composerRoot`, `workspaceFor`.
- Produces:
  - `class Outbox { constructor(post: (event: string, payload: unknown, options: { panel: string }) => void, options?: { windowMs?: number; maxPosts?: number; maxBytes?: number; delayMs?: number; now?: () => number }); send(panel: string, key: string, event: string, payload: unknown): void; dispose(): void }` — defaults `windowMs 10_000`, `maxPosts 180`, `maxBytes 240 * 1024`, `delayMs 150`. A later `send` with the same `key` replaces the queued payload; flushes stay within the window budget and resume when it frees; a diagnostics payload over `maxBytes` keeps the most severe diagnostics that fit and sets `truncated` to the number dropped.
  - `class PendingReveals { constructor(ttlMs?: number, now?: () => number); add(path: string, range: LspRange): void; paths(): string[]; take(path: string): LspRange | null; clear(): void }` — `ttlMs` default 30 s, at most 5 entries (oldest dropped).
  - `type RouterHost = { listWorkspaces(): Promise<WorkspaceRow[]>; openEditor(workspaceId: string, path: string): Promise<void>; post(event: string, payload: unknown, options: { panel: string }): void; status(update: StatusBarUpdate): void; log(message: string): void; settings(): Promise<{ phpantomPath: string; allowDownload: boolean }> }`
  - `class Router { constructor(host: RouterHost, options?: { resolve?: typeof resolveBinary; createServer?: (executable: string, root: string, events: ServerEvents) => PhpantomServer; idleMs?: number; sessionId?: string }); readonly session: string; open(input, caller: { panel: string }): Promise<AttachStatus>; change(input): Promise<…>; request(input, signal: AbortSignal): Promise<…>; close(input): Promise<{ ok: true }>; navigate(input): Promise<…>; peek(input): Promise<…>; restartAll(): Promise<string>; describe(): string; dispose(): Promise<void> }` — inputs and outputs exactly as the protocol's `phpantom.*` entries.
  - `main.ts` wires `orca.panels.handle('phpantom.open', (input, ctx) => router.open(input, { panel: ctx.panel.id }))` and the other five names, `phpantom.status` → `router.describe()`, `phpantom.restart` → `router.restartAll()`, `orca.settings.onDidChange` → forget the cached resolution, and `deactivate` → `router.dispose()`. `RouterHost.listWorkspaces` caches `workspace.list` for 10 s; `openEditor` calls `editor.open` with the path form Task 1 found.

Router rules:
- `session` is a `randomUUID()` made at construction; any `change`/`request`/`navigate`/`peek` whose `session` differs, or whose `docId` is unknown or whose server is not `alive`, answers `{ detached: true }` (`navigate` answers `{ opened: false, reason: 'failed' }`, `peek` answers no files).
- `open` collects chunks per `docId` (index 0 resets) and answers `{ state: 'pending' }` until `last`. Then: find the focused row (`resolveFocused(rows, workspaceId, { branch, displayName })`); if it exists and is not local, answer `{ state: 'remote', host: row.hostId }`; else `locateFile` with `candidates = reveals.paths()`, tier 0 the focused row's path, tier 1 the other local rows; `none`/`ambiguous` → `single-file`. Found → server key `composerRoot(path, workspacePath)`; start the server through `resolveBinary` (status `downloading` via `onDownload`, then `starting`) or reuse it; send `didOpen` with `languageId` from `language`; record `{ docId, panel, uri, version: 1, mirror }`; answer `ready` with `reveal` from `reveals.take(path)` when present. With `resync: true` on a known document, send one full-text `didChange` instead and reset the mirror and version to 1. Without `resync`, an `open` for a `docId` that is already attached first sends `didClose` to its old server and drops the old record (re-attach under another workspace), so the old server never posts to that `docId` again. A resolver failure answers `{ state: 'error', message }` and sets the status bar to error.
- `change`: `version !== doc.version + 1` → `{ resync: true }`; else `mirror.apply`, then `mirror.length !== length` → `{ resync: true }`; else forward `didChange` with `version`, store it, `{ ok: true }`.
- `request`: add `textDocument: { uri }` to `textDocument/*` methods; pass the handler's `signal`; if `JSON.stringify(result)` is over 900 KiB: a completion list keeps the leading items that fit with `isIncomplete: true`, anything else answers `{ error: 'too_large' }`; a server error answers `{ error: message }`.
- Diagnostics from the server are posted only for attached documents whose `uri` matches (`sameUri`), through `Outbox.send(panel, 'diag:' + docId, 'phpantom.diagnostics', …)`; refresh events are broadcast to each attached panel with key `refresh:<panel>` (kinds merged); a server exit posts `phpantom.status { state: 'error' }` to its documents and drops them (so they get `detached`). A crashed root restarts on the next `open`, at most 3 times in 5 minutes; past that it stays in error.
- `close` sends `didClose`; a server with no documents stops after `idleMs` (default 10 minutes, decided here).
- `navigate`: only `file:` URIs (`not-a-file` otherwise); `workspaceFor` the target path, preferring the document's own workspace (`outside-workspace` if none); `reveals.add(path, range)`; if another attached document already holds that `uri`, post `phpantom.reveal` to its panel and still call `openEditor` (which focuses that tab); `openEditor` failure → `failed`.
- `peek`: read each `file:` URI's text from disk, in order, stopping before 25 files or 600 KiB in total; `omitted` counts the rest.
- Status: each server reports its `ServerState`; the router calls `host.status(renderStatus(aggregate(states)))` at most once per second.

- [ ] **Step 1: Write the failing tests.** Router tests construct `Router` directly with a fake `RouterHost` (scripted `listWorkspaces`, recorded posts, status and `openEditor` calls) and `createServer` returning servers over `fake-server.mjs`, in temp workspace folders. One `mountWorker` test (`registers every handler and sets the status bar`) checks that `activate` handles the six `phpantom.*` names and calls `statusBar.update`.

```ts
test('attaches a document and answers hover through the server', async () => {
  const { worker, docs } = await setup({ files: { 'a/app/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  assert.equal(status.state, 'ready')
  assert.deepEqual(await worker.request('phpantom.request', { docId: 'd1', session: status.session, method: 'textDocument/hover', params: { position: { line: 0, character: 1 } } }), { result: { contents: { kind: 'markdown', value: 'len=12' } } })
})
test('a gap in versions asks for a resync', async () => { /* change with version 3 after open: { resync: true } */ })
test('re-opening a docId closes the old attachment', async () => { /* open d1 in ws-a, then open d1 (no resync) in ws-b: ws-a server got didClose; a BAD diagnostic from ws-a is not posted to d1 */ })
test('a length mismatch asks for a resync', async () => { /* changes applied but length off by one */ })
test('posts diagnostics only for attached documents', async () => { /* open a doc with BAD; expect one post with panel set; a second unopened file's diagnostics are not posted */ })
test('keeps posts under the rate limit and delivers the last set', async () => {
  const posts: unknown[] = []; let t = 0
  const outbox = new Outbox((e, p) => posts.push(p), { now: () => t, delayMs: 0 })
  for (let i = 0; i < 500; i++) { outbox.send('p' + (i % 300), 'diag:' + (i % 300), 'phpantom.diagnostics', { n: i }); t += 5 }
  await flushTimers()
  assert.ok(maxInAnyWindow(postTimes, 10_000) <= 180)
  assert.deepEqual(lastPayloadFor('p299'), { n: 299 })
})
test('truncates a diagnostics post over 240 KiB, most severe first', () => { /* 5000 diagnostics: payload under limit, errors kept before hints, truncated > 0 */ })
test('answers detached after a server crash', async () => { /* change text to include CRASH, wait for exit; next request → { detached: true }; a phpantom.status error post reached the panel */ })
test('a new worker session makes old documents detached', async () => { /* request with a different session id → detached */ })
test('a remote focused workspace is never attached', async () => { /* workspace.list row hostId 'ssh:box': { state: 'remote', host: 'ssh:box' } and no server started */ })
test('navigate stores a reveal that the next open of that file picks up', async () => { /* navigate to file:///…/vendor/x/Y.php: editor.open called with ws id and path; then open with Y.php's text → ready with reveal */ })
test('a reveal is dropped after 30 s', () => { /* PendingReveals with fake now */ })
test('truncates an oversized completion list', async () => { /* fake server returns 5000 items of 400 bytes; answer under 1 MiB with isIncomplete true */ })
test('stops an idle server after the idle time', async () => { /* idleMs 50: close the only doc, wait, server.alive false */ })
```

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement `outbox.ts`, `reveals.ts`, `router.ts`, and the wiring in `main.ts`.**
- [ ] **Step 4: Run, see them pass.** `orca plugin test .` → PASS.
- [ ] **Step 5: Try it against the real server**

Run: `orca plugin dev load . --approve <fingerprint>`, then `orca plugin dev request . phpantom.open --data '{"docId":"t1","language":"php","workspaceId":"<id from workspace.list>","branch":null,"displayName":null,"index":0,"chunk":<JSON string of a file from that workspace>,"last":true}'`, then `orca plugin logs local.phpantom` and `orca plugin shot . --status-bar`.
Expected: the answer is `ready`; logs show the resolution source and `PHPantom v1.1.0` startup; the status bar shows indexing, then ready. Editors attach in Task 10.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat(worker): route editor requests to one PHPantom per composer root"
```

---

### Task 10: Editor bridge: attach, sync, reattach

**Files:**
- Create: `editor/src/bridge.ts`, `editor/src/bridge.test.ts`, `editor/src/attach.ts`, `editor/src/lsp-convert.ts` (vendored), `editor/src/lsp-convert.test.ts` (vendored)
- Modify: `editor/src/main.ts`

**Interfaces:**
- Consumes: protocol (Task 2); `REQUEST_BUDGET_BYTES`, `chunkText`, `splitChanges` (Task 7); `startEditor`, `showNote`, `clearNote` (Task 4).
- Produces:
  - `type BridgeHost = { request<K extends keyof PluginRequests>(name: K, input: PluginRequestInput<K>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PluginRequestOutput<K>>; on(event: string, handler: (payload: any) => void): { dispose(): void }; readContext(): Promise<{ workspaceId: string | null; branch: string; displayName: string } | null>; onVisible(listener: () => void): { dispose(): void } }` — the real one wraps `orca.plugin` and `orca.host.call('workspace.readContext', {})`.
  - `type DocumentSource = { language: Language; getText(): string; getLength(): number; getVersion(): number; onChanges(listener: (changes: LspContentChange[], isFlush: boolean) => void): { dispose(): void } }` — the Monaco model adapter in `attach.ts` converts `IModelContentChange` with `toLspContentChange`.
  - `class LspBridge { constructor(host: BridgeHost, source: DocumentSource, options?: { docId?: string; syncDelayMs?: number; retryGapMs?: number; maxRetries?: number }); attach(): Promise<AttachStatus>; readonly status: AttachStatus | null; ask(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown | null>; onReady(listener: (status: AttachStatus & { state: 'ready' }) => void): { dispose(): void }; onDiagnostics(listener: (diagnostics: unknown[]) => void): { dispose(): void }; onRefresh(listener: (kinds: string[]) => void): { dispose(): void }; onReveal(listener: (range: LspRange) => void): { dispose(): void }; dispose(): void }`
  - `lsp-convert.ts` copied from `editor/src/lsp-convert.ts` at `da5a680` (header added, `sameUri` imported from `../../src/lsp/uri.ts`), exporting `toLspPosition`, `fromLspRange`, `toLspRange`, `markerSeverity`, `toMarker`, `completionKindName`, `toMarkdown`, `markdownValue`, `toMonacoEdit`, `normalizeLocations`, `splitWorkspaceEdit`, `toDocumentSymbols`, `completionDetails`, the types `LspDiagnostic`, `LspTextEdit`, `LspWorkspaceEdit`, `MonacoRange`, plus one addition: `toLspContentChange(change: { range: MonacoRange; text: string }): LspContentChange`.
  - `attachLanguageServer(ctx: EditorContext): LspBridge` in `editor/src/attach.ts`, called from `main.ts` after `startEditor()`: builds the bridge, shows notes for `single-file` (`PHPantom couldn't tell which file this is, so only highlighting is on. It will try again after you save.`), `remote` (`This file is on <host>. PHPantom runs on this computer only, so only highlighting is on.`) and `error` (the message), clears them on `ready`.

Rules:
- `attach` reads the context (its `workspaceId`, `branch` and `displayName` go into every `phpantom.open`), sends the text through `phpantom.open` in `chunkText` pieces (sequentially, `timeoutMs: 120_000` on the last piece), and stores the answer. `single-file` and request failures retry later (no sooner than `retryGapMs` 8 s and only after 2 s without typing or when the tab becomes visible, at most `maxRetries` 20 times), as Autocomplete's retry loop does.
- Changes made after the text snapshot of an in-flight attach (which can take up to 120 s on a cold index or a download) are queued and sent in order, starting at version 2, once the answer is `ready`; any other answer drops the queue, since the next attach sends a fresh snapshot.
- Changes are queued in order and sent after `syncDelayMs` (50 ms) of quiet, one `phpantom.change` in flight at a time; each group from `splitChanges` gets the next version number. `isFlush` (whole value replaced), `{ resync: true }`, or a failed change send the full text again through `phpantom.open` with `resync: true`.
- `{ detached: true }`, an `unavailable` rejection, or a `ready` answer with a different `session` → full re-attach (with the 5 s gap Autocomplete uses), then the pending `ask` is retried once.
- `ask` flushes queued changes first, then sends `phpantom.request` with the signal; it returns `null` when the signal aborted, the answer carries `error`, or the document version moved for these methods: `textDocument/formatting`, `textDocument/rangeFormatting`, `textDocument/rename`, `codeAction/resolve`.
- When the tab becomes visible, read the context; if its `workspaceId` differs from the one used for the current attach, re-attach.
- `pagehide` sends `phpantom.close`.

- [ ] **Step 1: Vendor `lsp-convert.ts` and its test** at `da5a680`. Run `orca plugin test .`; Expected: the vendored tests PASS.

- [ ] **Step 2: Write the failing tests** (a fake `BridgeHost` that records calls and scripts answers; a fake `DocumentSource` over a string; plus `toLspContentChange` in `lsp-convert.test.ts`)

```ts
test('sends a large document in chunks and attaches', async () => {
  const host = fakeHost({ open: readyOn('last') })
  const bridge = new LspBridge(host, source('x'.repeat(200_000)))
  assert.equal((await bridge.attach()).state, 'ready')
  assert.ok(host.calls('phpantom.open').length > 1)
  assert.ok(host.calls('phpantom.open').every((c) => encodedSize(c.input) <= 64 * 1024))
})
test('keeps edits typed while attach is in flight', async () => { /* open answers after a delay; two same-length edits made meanwhile are sent as versions 2 and 3 after ready */ })
test('sends changes in order with consecutive versions', async () => { /* three edits → change calls with versions 2,3,4 in order, never two in flight */ })
test('a resync answer sends the whole text again', async () => { /* change answers { resync: true } → open with resync: true */ })
test('re-opens after the worker reports a new session', async () => { /* request answers { detached: true }; expect a fresh open, then the request retried once */ })
test('re-attaches when the tab shows under another workspace', async () => { /* readContext returns ws-a then ws-b on visible → second full open with workspaceId ws-b */ })
test('drops a formatting result when the text changed meanwhile', async () => { /* version moves before the answer arrives → ask resolves null */ })
test('retries a single-file attach after typing stops', async () => { /* first open → single-file, then ready on the retry */ })
test('content changes keep Monaco ranges as zero-based LSP ranges', () => {
  assert.deepEqual(toLspContentChange({ range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 5 }, text: 'x' }), { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, text: 'x' })
})
```

- [ ] **Step 3: Run, see them fail.**
- [ ] **Step 4: Implement `bridge.ts`, `toLspContentChange` and `attach.ts`** (diagnostics go to `monaco.editor.setModelMarkers(model, 'phpantom', …)` via `toMarker`; reveals call `editor.revealRangeInCenter` and set the selection).
- [ ] **Step 5: Run, see them pass; rebuild** — `orca plugin test . && node editor/build.mjs && orca plugin check .`
- [ ] **Step 6: Look at it** — `orca plugin shot . --editor <laravel>/app/Http/Controllers/Controller.php` after the status bar says ready; Expected: PHPantom markers visible on a file with a known problem.
- [ ] **Step 7: Commit**

```bash
git add editor
git commit -m "feat(editor): attach to PHPantom, keep it in sync incrementally and recover from restarts"
```

---

### Task 11: Reading features: diagnostics, completion, hover, signature help, semantic tokens, inlay hints, outline

**Files:**
- Create: `editor/src/providers.ts`
- Modify: `editor/src/lsp-convert.ts`, `editor/src/lsp-convert.test.ts`, `editor/src/attach.ts`

**Interfaces:**
- Consumes: `LspBridge`, `attachLanguageServer` and the vendored `lsp-convert.ts` (Task 10), `EditorContext` (Task 4).
- Produces (added to `lsp-convert.ts`):
  - `type LspInlayHint = { position: LspPosition; label: string | { value: string; tooltip?: string }[]; kind?: 1 | 2; tooltip?: string | { kind: string; value: string }; paddingLeft?: boolean; paddingRight?: boolean }`
  - `toCompletionLabel(item: { label: string; labelDetails?: { detail?: string; description?: string } }): string | { label: string; detail?: string; description?: string }`
  - `toInlayHint(hint: LspInlayHint): { label: string | { label: string; tooltip?: string }[]; position: { lineNumber: number; column: number }; kind?: 1 | 2; tooltip?: string | { value: string }; paddingLeft?: boolean; paddingRight?: boolean }`
  - `toSemanticTokens(result: { data: number[]; resultId?: string } | null): { data: Uint32Array; resultId?: string } | null`
  - `registerReadingProviders(ctx: EditorContext, bridge: LspBridge, capabilities: Record<string, unknown>): { dispose(): void }` in `providers.ts`

Registration rules: register each provider only when `capabilities` has it, for the model's own language id (`php` or `blade`, never `'*'`), and only answer for `ctx.model`. Completion: as Autocomplete's provider plus `label: toCompletionLabel(item)` and `resolveCompletionItem` through `completionItem/resolve` (this is where PHPantom's auto-import `additionalTextEdits` arrive). Semantic tokens: `getLegend()` returns `capabilities.semanticTokensProvider.legend`; `onDidChange` fires on `phpantom.refresh` with `semanticTokens`; `provideDocumentSemanticTokens` asks `textDocument/semanticTokens/full`. Inlay hints: asks `textDocument/inlayHint` for the visible range; `onDidChangeInlayHints` fires on `phpantom.refresh` with `inlayHints`. Diagnostics: keep the raw LSP diagnostics (Task 12 sends them with code actions) and set markers through `toMarker`. Every provider passes Monaco's cancellation token as an `AbortSignal` to `bridge.ask`.

- [ ] **Step 1: Write the failing tests for the additions**

```ts
test('completion labels carry PHPantom label details', () => {
  assert.deepEqual(toCompletionLabel({ label: 'greet($who)', labelDetails: { detail: ': string', description: 'User' } }), { label: 'greet($who)', detail: ': string', description: 'User' })
  assert.equal(toCompletionLabel({ label: 'name' }), 'name')
})
test('inlay hints move to one-based positions and keep their kind', () => {
  assert.deepEqual(toInlayHint({ position: { line: 12, character: 28 }, label: 'who:', kind: 2, tooltip: 'string $who', paddingRight: true }),
    { label: 'who:', position: { lineNumber: 13, column: 29 }, kind: 2, tooltip: 'string $who', paddingRight: true })
})
test('semantic tokens become a Uint32Array', () => {
  assert.deepEqual([...toSemanticTokens({ data: [3, 21, 2, 6, 32] })!.data], [3, 21, 2, 6, 32])
  assert.equal(toSemanticTokens(null), null)
})
```

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement the additions and `registerReadingProviders`; call it from `onReady` in `attach.ts`** (dispose and re-register on each re-attach, since capabilities can change with a new server).
- [ ] **Step 4: Run, see them pass; rebuild and check** — `orca plugin test . && node editor/build.mjs && orca plugin check .`
- [ ] **Step 5: Look at it**

Run against a Laravel project: `orca plugin shot . --editor <file> --act '[{"click":[300,200]},{"key":"End"},{"key":"Enter"},{"key":"$"},{"key":"t"},{"key":"h"},{"key":"i"},{"key":"s"},{"key":"-"},{"key":">","modifiers":["shift"]}]'`
Expected: a completion list with members; a second shot with a parameter in view shows the parameter coloured and a parameter-name inlay hint. Read the PNGs. If a feature is broken at 1.1.0, drop its registration, note it in `README.md` under "Known gaps", and continue (spec: builder's call).

- [ ] **Step 6: Commit**

```bash
git add editor
git commit -m "feat(editor): PHPantom diagnostics, completion, hover, signature help, colouring, inlay hints and outline"
```

---

### Task 12: Navigation and edits: definition, references, formatting, rename, code actions

**Files:**
- Create: `editor/src/navigation.ts`, `editor/src/navigation.test.ts`
- Modify: `editor/src/providers.ts`, `editor/src/lsp-convert.ts`, `editor/src/lsp-convert.test.ts`, `editor/src/attach.ts`

**Interfaces:**
- Consumes: `LspBridge`, `phpantom.navigate`, `phpantom.peek` (Tasks 9, 10); vendored `normalizeLocations`, `splitWorkspaceEdit` (Task 10); `showNote` (Task 4).
- Produces:
  - `mapLocations(locations: { uri: string; range: MonacoRange }[], documentUri: string, modelUri: string): { uri: string; range: MonacoRange }[]` — the document's own URI becomes the model's `inmemory://` URI; others stay `file:` URIs.
  - `class PeekModels { constructor(create: (uri: string, text: string) => { dispose(): void }, limit?: number); ensure(files: { uri: string; text: string }[]): void; has(uri: string): boolean; dispose(): void }` — keeps at most `limit` (default 30) read-only models, least recently used dropped first.
  - `type LspCodeAction = { title: string; kind?: string; isPreferred?: boolean; edit?: LspWorkspaceEdit; data?: unknown; command?: unknown }`; `type MonacoWorkspaceEdit = { edits: { resource: string; textEdit: { range: MonacoRange; text: string }; versionId: undefined }[] }` (the provider turns `resource` into a `monaco.Uri`)
  - `toCodeAction(action: LspCodeAction, documentUri: string, modelUri: string): { title: string; kind?: string; isPreferred?: boolean; edit?: MonacoWorkspaceEdit; needsResolve: boolean; otherFiles: number } | null` — `null` for a bare command (no `edit`, no `data`).
  - `registerEditingProviders(ctx: EditorContext, bridge: LspBridge, capabilities: Record<string, unknown>): { dispose(): void }` in `providers.ts`.
  - `installOpener(ctx: EditorContext, bridge: LspBridge): { dispose(): void }` in `navigation.ts`.

Behaviour (v1 choices, flagged for the owner):
- Definition, declaration, type definition, implementation and references go through `mapLocations`. Before answering, the provider calls `phpantom.peek` for the `file:` URIs that have no model and creates read-only models for them with `PeekModels`, so Monaco's peek view and Cmd-hover preview work. Locations whose file was `omitted` are left out, and the provider shows a note `N more results are in files not shown here.`.
- `monaco.editor.registerEditorOpener`: a resource other than the model's own calls `phpantom.navigate` with the target range and returns `true`; `outside-workspace` shows `That definition is outside your open workspaces.` and `not-a-file` shows `That definition is in PHP's built-in stubs, which have no file to open.` The opened tab later receives its `reveal` through attach (Task 9).
- Formatting and range formatting through `bridge.ask` (it drops stale answers); `timeoutMs` 30 s, since PHPantom may run Pint.
- Rename: `textDocument/prepareRename` then `textDocument/rename`; when `splitWorkspaceEdit` reports other files, reject with `Renaming here would also change N other files. Cross-file rename isn't supported yet.`
- Code actions: send the raw diagnostics that touch the range and `context.only`; convert with `toCodeAction`; `resolveCodeAction` asks `codeAction/resolve` with the server's original action (kept in a `WeakMap`); a resolved edit that touches other files is not applied, and a note says `This fix also changes other files, which isn't supported yet.`.

- [ ] **Step 1: Write the failing tests**

```ts
test('own-file locations point at the in-memory model', () => {
  assert.deepEqual(mapLocations([{ uri: 'file:///w/a.php', range: r(1, 1, 1, 4) }, { uri: 'file:///w/B.php', range: r(9, 21, 9, 21) }], 'file:///w/a.php', 'inmemory://phpantom/d1.php'),
    [{ uri: 'inmemory://phpantom/d1.php', range: r(1, 1, 1, 4) }, { uri: 'file:///w/B.php', range: r(9, 21, 9, 21) }])
})
test('a data-only action needs resolve; a bare command is dropped', () => {
  assert.equal(toCodeAction({ title: 'Extract function', kind: 'refactor.extract', data: { action_kind: 'refactor.extractFunction' } }, U, M)?.needsResolve, true)
  assert.equal(toCodeAction({ title: 'Run', command: { title: 'x', command: 'phpantom.navigateToPrototype' } }, U, M), null)
})
test('an action with edits to other files reports them', () => { /* changes for U and another uri → otherFiles 1 */ })
test('peek models are capped and least recently used go first', () => { /* limit 2, ensure 3 files, first disposed */ })
```

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement `navigation.ts`, `toCodeAction`, and `registerEditingProviders`; wire both in `attach.ts` next to Task 11's providers.**
- [ ] **Step 4: Run, see them pass; rebuild and check** — `orca plugin test . && node editor/build.mjs && orca plugin check .`
- [ ] **Step 5: Try it by hand in Orca** (shots cannot follow a tab switch): in a Laravel project, Cmd-click a model class in a controller → the model file opens in Orca with the class line revealed; Shift+F12 on a method → the peek list shows other files; format a messy file; rename a local variable; apply a "remove unused import" quick fix. Record what worked in the Task 13 smoke notes.
- [ ] **Step 6: Commit**

```bash
git add editor
git commit -m "feat(editor): cross-file navigation, references, formatting, rename and quick fixes"
```

---

### Task 13: End-to-end check, coexistence and docs

**Files:**
- Create: `docs/smoke/v1-smoke.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the smoke record and the README the owner's team installs from.

- [ ] **Step 1: Run the full gate locally**

Run: `npm ci && orca plugin types . && npx tsc -p . && orca plugin validate . && orca plugin check . && orca plugin test . && node editor/build.mjs && git diff --exit-code -- editor/dist && git ls-files -z | xargs -0 du -ck | tail -1 && git ls-files | wc -l`
Expected: every command exits 0; the tracked files total under 50 MiB (51,200 K) and number under 2,000.

- [ ] **Step 2: Smoke on a real Laravel project with two worktrees open**, installing from the pushed branch (`orca plugin install noppu-labs/orca-phpantom@<branch>`), and record each line as pass or fail in `docs/smoke/v1-smoke.md`: opening `.php` and `.blade.php` opens PHPantom's editor; save, dirty state and the outside-change behaviour match Orca's; an agent (`echo` into the file from a terminal) writing during unsaved edits merges; undo after that still works; each v1 feature from the spec's Goals list; a 1 MB PHP file stays responsive while typing; Cmd-click into `vendor/` opens and reveals; the same file in worktree B attaches to B; a remote (SSH) workspace file shows the remote note; `phpantom.restart` and `orca plugin restart` both recover within a few seconds; status bar phases; with `allowDownload` on and no binary on `PATH`, the download runs and the tooltip says `downloaded`.

- [ ] **Step 3: Coexistence with Autocomplete** — with Autocomplete installed and enabled, open a `.php` file and record which editor opens by default and how to switch (Orca's view toggle). Write the result in `README.md` under "Using it with Autocomplete" (spec open point).

- [ ] **Step 4: Finish the README**: install from Git, what it needs (desktop app, local workspaces), binary resolution order and the `phpantomPath`/`allowDownload` settings, semantic token mode (`contextual` by default; set `[semantic-tokens] mode = "full"` in `.phpantom.toml` for full colouring), "Known gaps" (cross-file rename and cross-file fixes, remote workspaces, anything dropped in Task 11), and credits (PHPantom, Autocomplete).

- [ ] **Step 5: Commit**

```bash
git add docs/smoke/v1-smoke.md README.md
git commit -m "docs: record the v1 smoke run and finish the README"
```
