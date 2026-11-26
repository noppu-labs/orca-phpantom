# PHPantom for Orca: design

Date: 2026-11-26
Repo: `noppu-labs/orca-phpantom` (to be created; this doc moves to `docs/superpowers/specs/` there)
Status: approved by owner 2026-11-26

## Intent

The owner works on Laravel projects in Orca and wants real PHP and Laravel language support in
Orca's editor: errors, completion, hover, go to definition, project-aware colouring. PHPantom
(`PHPantom-dev/phpantom_lsp`, Rust, MIT) already understands Laravel out of the box (Eloquent
relations, scopes, casts, container strings, Blade, Livewire, Pest) with no ide-helper or database
access, so the plugin should be a thin host for PHPantom rather than PHP intelligence of its own.

Orca gives plugins no way to attach a language server to its own editor: there is no
language-server contribution point and Orca's Monaco instance is not exposed. The owner chose to
work around that the way `actus7/orca-autocomplete` does: ship our own editor.

## Approaches considered

1. **Own PHP and Blade custom editor (chosen).** A custom editor, default for `.php` and
   `.blade.php`, bundles Monaco; a trusted worker runs `phpantom_lsp` and bridges LSP to it. We
   control the PHP/Laravel experience. Costs: we maintain a bundled Monaco, the editor never learns
   its file path, desktop app only.
2. **Add PHPantom to Autocomplete.** A few lines in that plugin's server table. Cheapest, but not
   ours, tied to its AI features, and no room for Laravel-specific work.
3. **Propose a language-server contribution point to Orca core.** Best end state (Orca's own editor
   talks LSP), but slow and not ours to decide. Can be pursued later; if it ships, the worker half of
   this plugin carries over and the editor half is dropped.

## Goals (v1)

- Opening a `.php` or `.blade.php` file in a local Orca workspace opens our editor in the normal
  editor tab, looking and behaving like Orca's (theme, typography, save, dirty state, outside-change
  banner all stay Orca's).
- PHPantom features in that editor: diagnostics, completion (with auto-import), hover, signature
  help, semantic-token colouring, inlay hints, document symbols / outline, find references, go to
  definition, code actions and quick fixes, formatting, rename within the open file.
- Go to definition into another file opens that file in Orca (`editor.open`) and reveals the target
  line once the new editor has located itself (see Constraints: `editor.open` takes no position).
- One PHPantom process per workspace root, started lazily on the first PHP file opened there and
  stopped after an idle period.
- PHPantom binary found or fetched without the user doing anything (see Binary).
- Editing is never worse than Orca's Source view: no lost keystrokes, no lost edits when an agent
  writes the file, undo works, large files stay responsive.

## Non-goals (v1)

- Remote workspaces (SSH, WSL, paired hosts). The worker runs on the desktop; PHPantom needs the
  project on local disk. Remote files fall back to plain highlighting with a note.
- Cross-file rename and other workspace edits that touch files other than the open one (v2: the
  worker can apply them to disk; needs care with open tabs).
- AI completions, snippets beyond what PHPantom offers.
- An MCP server exposing PHPantom to agents (candidate for v1.1; `contributes.mcpServers`).
- Browser clients and the paired web client (custom editor runs with `"frame": "isolated"`).

## Anti-goals

- Losing or silently overwriting edits, including when an agent rewrites the open file.
- Making Orca feel slower: typing latency, startup, or memory beyond PHPantom's own.
- Sending code anywhere. The only network call is the one-off binary download from GitHub releases.

## Architecture

```
Orca editor tab ── custom editor frame (isolated) ──plugin.request / posts── worker (Node) ──stdio── phpantom_lsp
                   Monaco + LSP<->Monaco adapters                             LSP client, process
                   orca.document.session() sync                               manager, file locator,
                                                                              binary resolver
```

- **Editor frame**: bundled `monaco-editor` (plain, no `monaco-languageclient`; Autocomplete shows
  the hand-rolled LSP<->Monaco conversion is small and keeps the entry under the 10 MiB limit).
  Syncs the document with `orca.document.session()` and a `merge` so an agent's write during
  unsaved edits merges instead of dropping the draft. Registers Monaco providers that forward to the
  worker. Follows Orca's theme via `--orca-*` variables and `editor.readTypography`.
- **Worker** (`trusted-worker`, `main`): one LSP client per workspace root, JSON-RPC over the
  child's stdio, request/response routing back to the right editor, diagnostics pushed to editors
  with `orca.panels.post`.
- **File locator**: the editor frame never gets a path. The worker finds the file by matching the
  document's text against workspace files of that type (exact match, then "most shared lines" for a
  document with unsaved edits), as Autocomplete's `src/lsp/locate.ts` does.
  *Worktrees (builder's call, recorded here):* sibling worktrees of one repo hold near-identical
  files, so a search across every workspace would be ambiguous most of the time. When the editor
  starts it calls `workspace.readContext` (allowed on the editor surface, `workspace:read`) and sends
  the focused workspace id with its first request; the worker searches that workspace's path (from
  `workspace.list`) first and only falls back to other local workspaces when nothing matches there
  (for example a tab restored in the background after a restart). No match or an ambiguous match
  degrades to single-file mode with a visible note.
  *Remote files:* `workspace.list` gives each workspace's `hostId`; when the focused workspace is not
  `local`, the editor does not attach PHPantom and shows plain highlighting with a note, so a remote
  file is never attached to a local look-alike.
  *First task of the plan is a spike* that confirms this on a repo with two worktrees open.
- **Worker lifetime (builder's call):** Orca keeps a worker running while the plugin is enabled when
  the plugin contributes a status bar item, so the plugin contributes one (PHPantom state: starting,
  indexing, ready, error, with the binary version in its tooltip). The worker process model is still
  marked experimental, so the plan must also handle a restart: editors re-send `didOpen` when a
  request fails with `unavailable` or the worker reports a new session id; pending reveals are
  dropped on restart; PHPantom children are started so they exit when the worker's stdio closes.
- **Workspace root**: nearest `composer.json` at or above the file, within the Orca workspace;
  falls back to the workspace folder.
- **Binary resolver**: see below.
- **Colouring (builder's call):** base highlighting from Monaco's built-in `php` tokenizer, plus a
  small Monarch tokenizer for Blade (`{{ }}`, `{!! !!}`, `@directives`, `<x-component>` tags) layered
  on Monaco's HTML. PHPantom's semantic tokens then colour on top of both. No TextMate engine.
- **Blade:** PHPantom handles `.blade.php` itself (virtual PHP preprocessing), so the worker sends
  Blade documents as-is; the builder confirms the `languageId` PHPantom expects.
- **Sync (builder's call):** incremental `didChange` from Monaco's change events from day one;
  `didOpen` for documents over 64 KiB is chunked across requests. Target: files up to 1 MB stay
  responsive, and providers never block typing (all async, stale results dropped).

Reusing Autocomplete's MIT-licensed code (locator, JSON-RPC, LSP conversion, build script) is
allowed with attribution and is encouraged where it fits.

## Binary

A plugin folder may hold at most 50 MiB and 2,000 files; one unpacked PHPantom binary is about
58 MiB, so it cannot be bundled. Resolution order:

1. The path in the plugin setting `phpantomPath`, if set.
2. `phpantom_lsp` on `PATH` (Homebrew, cargo) if its version is at least the plugin's minimum.
3. Otherwise download the plugin's pinned PHPantom release (builder's call: pin `1.1.0`, released
   2026-11-24, which is also the minimum accepted from `PATH`) for this OS/arch from GitHub releases,
   verify it against a SHA-256 committed in the plugin, unpack it to a per-user cache directory, and
   use it. A setting turns downloading off.

Platforms: macOS arm64/x64, Linux arm64/x64, Windows x64/arm64 (PHPantom ships all six). The 5 MiB
`wasm32-wasip1` build could be bundled instead of downloading; untested, out of scope unless a spike
shows it runs as a language server under Node's WASI.

## Constraints from Orca (as documented on 2026-11-26)

- `plugin.request`: input at most 64 KiB, answer at most 1 MiB, default timeout 30 s. A `didOpen` /
  full `didChange` for a file over 64 KiB must be chunked or sent as incremental changes.
- Worker-to-editor posts: at most 256 KiB each and 200 per 10 s per plugin, so diagnostics and
  other pushes must be batched/debounced.
- Custom editor `entry` at most 10 MiB; each `.ts` Orca transpiles at most 1 MiB, so the editor is
  prebuilt with esbuild and `editor/dist` is committed (Orca installs plugins as plain files, no
  build step).
- Max 16 custom editors and 32 extensions each.
- `editor.open(workspaceId, path)` has no line/column: cross-file definition stores a pending
  reveal in the worker that the newly opened editor picks up once located.
- Orca keeps no undo history for custom editors; Monaco's undo must be kept intact across
  `onReplace`.
- Needs `engines.orca` at least the version that has every field used (Autocomplete targets
  `>=1.4.257`).

## Settings (v1)

- `phpantomPath` (string, empty = auto)
- `allowDownload` (boolean, default true)
- `enabled` features toggles only if needed; otherwise PHPantom's own `.phpantom.toml` configures
  analysis (PHPStan, Pint/PHPCS integration, etc.).

## Repository and release

- Repo `noppu-labs/orca-phpantom`, MIT. Plugin id `phpantom` (ids starting `orca-` are reserved),
  installs as `noppu-labs.phpantom`, display name "PHP & Laravel (PHPantom)".
- CI: `orca plugin validate .`, `orca plugin check`, unit tests (worker, locator, LSP conversion),
  editor build reproducibility check (committed `editor/dist` matches a fresh build).
- Audience (owner's decision): the repo is public from the start, but v1 is for the owner and their
  team, installed from Git (`orca plugin install noppu-labs/orca-phpantom`). Once a v1 works for
  them, it is listed in the Orca plugin directory: tag `vX.Y.Z` and add the `orca-plugin` topic.
  Until then, do not add the topic. Windows and docs polish can wait for the listing.

## Open points

- Coexistence with Autocomplete: both claim `.php` as a default editor. How Orca picks between two
  default custom editors is unverified; the builder should test it and document the result.

## Left to the builder

- Code layout, test framework, exact idle timeout, how diagnostics are batched.
- Which LSP features land first within v1. PHPantom's README lists every v1 feature as supported;
  if one turns out broken at the pinned version, it is dropped from v1 and listed as a known gap
  rather than holding the release (builder's call).
- Whether to vendor Autocomplete code or rewrite.
