# v1 smoke run

Date: 2026-11-26. Orca 1.4.277 (host API 1.10) on macOS arm64, PHPantom 1.1.0 from Homebrew
(`/opt/homebrew/bin/phpantom_lsp`). Plugin commit `b846f2f` on `feat/v1`.

## How it was run

- Test project: a fresh `composer create-project laravel/laravel` skeleton in `$TMPDIR`, committed
  to a new Git repo and added to Orca with `orca repo add`. A second worktree, `smoke-b`, was made
  with `orca worktree create --name smoke-b --base-branch main --no-parent --setup skip`. Worktree A
  has `vendor/` (it is gitignored, so B does not). Extra files: `app/Smoke/Demo.php` (calls, an
  unknown function, a class without its import), `app/Smoke/Format.php` (badly formatted),
  `app/Smoke/Big.php` (1,055,952 bytes, 5,820 methods) and `resources/views/smoke.blade.php`.
- The project and both worktrees were set up and focused before the plugin was installed or loaded.
- Installed check: `orca plugin install noppu-labs/orca-phpantom@feat/v1`, then uninstalled.
- Everything else ran under `orca plugin dev load .`. Focus and tabs were driven with
  `orca file open --focus`, `orca worktree activate` and `orca plugin shot`, never by clicking.
- Two temporary read-only handlers were added to `src/main.ts` for the run and removed before the
  commit: one returned `router.describe()` plus the list of attached documents, and one called the
  same `restartAll()` that the `PHPantom: Restart language servers` command runs. The CLI has no way
  to run a palette command, and `orca plugin dev request` reaches only request handlers.
- Feature checks sent the worker the same requests the editor sends (`phpantom.open` in 60,000
  character chunks, `phpantom.request`, `phpantom.change`, `phpantom.navigate`) with
  `orca plugin dev request`. Times below include about 0.1 s of CLI start-up per call.
- Things that need a person at the keyboard (typing, undo, widgets, Cmd-click) are on the hand
  checklist at the end. `orca plugin shot --act` can type into an editor, but only while Orca's
  window is hidden or minimized, and the window stayed visible for this run.

## Gate

`npm ci && orca plugin types . && npx tsc -p . && orca plugin validate . && orca plugin check . && orca plugin test . && node editor/build.mjs && git diff --exit-code -- editor/dist && git ls-files -z | xargs -0 du -ck | tail -1 && git ls-files | wc -l`

Pass, exit 0. `orca plugin check`: both editors load 6 files. `orca plugin test`: 228 tests, 228
pass, 24 test files. `editor/dist` is 4.57 MiB in 8 files and equal to a fresh build. Tracked files
total 5,340 K in 91 files (before this document was added).

## Results

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Installs from Git and runs from plain files | Pass | `resolvedCommit: b846f2fbe3bf6a1d5438551bf9fbca414276e3b4` (equal to `origin/feat/v1`). The installed folder has no `node_modules` and holds `editor/dist`. `orca plugin list`: `noppu-labs.phpantom 0.1.0 running trusted-worker`. Opening `app/Smoke/Co1.php` logged `Starting PHPantom 1.1.0 for $TMPDIR/phpantom-smoke-app` and started one `phpantom_lsp --stdio`. An editor shot of a fresh copy of `Demo.php` shows PHPantom's inlay hints. No other project was attached. |
| 2 | Uninstall | Pass | `orca plugin uninstall noppu-labs.phpantom`: `removed: true`. Gone from `orca plugin list` and from Orca's plugins folder, and its `phpantom_lsp` exited. |
| 3 | `.php` opens PHPantom's editor | Pass | `orca file open app/Smoke/Co1.php --focus` attached a document. `orca plugin shot --editor app/Smoke/Co3.php`: `editorId: php`. |
| 4 | `.blade.php` opens PHPantom's Blade editor | Pass | `orca file open resources/views/co3.blade.php --focus` attached a document. `orca plugin shot --editor resources/views/smoke.blade.php`: `editorId: blade`, with Blade directives coloured. |
| 5 | Closed and re-shown tabs are released | Pass | Six opens (five in A, one in B) took the attached count from 0 to 5 (the first one did not attach, see the next row), and each re-shown tab mounts a new frame. Switching worktrees did not remount anything. With no further switches the count fell to 2, the active tab of A and of B, between 52 and 67 s after the last switch. A tab opened and closed by `orca plugin shot` was released 61 to 76 s later. |
| 6 | A tab already open when the plugin loads | Unverified | `Demo.php` in A was opened in Source before the plugin was installed. The first `orca file open` of it after `orca plugin dev load` did not attach; a later open of the same file did. Not investigated. |
| 7 | Same file in worktree B attaches to B | Pass | `Demo.php` is byte-identical in A and B. Opening it in B attached `~/orca/workspaces/phpantom-smoke-app/smoke-b/app/Smoke/Demo.php` and started a second PHPantom for B. Synthetic opens with A's workspace id attached A's copy. |
| 8 | Diagnostics | Pass | PHPantom published 4 for `Demo2.php`: `unknown_function` (error), `unknown_class` (warning) and two `unused_variable` hints. A window shot shows the red and yellow squiggles and the ruler marks. They arrive a moment after the editor paints, so a shot taken at first paint shows none. |
| 9 | Completion, with auto-import | Pass | `$this->user->` gave 725 items led by `created_at`, `email`, `email_verified_at` (Eloquent properties), 0.17 s. After typing `new Collec`, the `Collection` items carry `additionalTextEdits` that add the `use` line, and `completionItem/resolve` adds the documentation. |
| 10 | Hover | Pass | On `greet`: `public function greet(string $name, int $times = 1): string`, 0.12 s. In Blade, on `$user`: `$user = mixed`. |
| 11 | Signature help | Pass | Inside `greet(`: `(string $name, int $times = 1): string`, active parameter 0. |
| 12 | Semantic colouring | Pass | `semanticTokens/full` answered 25 integers (5 tokens) for `Demo.php` in the default `contextual` mode; parameters are coloured in the shots. |
| 13 | Inlay hints | Pass | `string:`, `name:`, `times:` for `Demo.php`, visible in the editor shots. In Blade PHPantom answers a stray `value:` hint, which the editor leaves out (see the README). |
| 14 | Outline (document symbols) | Pass, with a gap | `Demo` with `__construct`, `$user`, `greet`, `run`. For `Big.php` the answer was cut to 0 items (`truncated: 1`): its one class is larger than Orca accepts in one answer. |
| 15 | Find references, highlights | Pass | `greet`: the declaration and the call. `$message`: write and read highlights. |
| 16 | Go to definition | Pass | `greet` goes to line 13 of the same file, `User` to `app/Models/User.php`. |
| 17 | Definition into `vendor/` opens and reveals | Pass | From `app/Models/User.php`, `Authenticatable` resolves to `vendor/laravel/framework/src/Illuminate/Foundation/Auth/User.php` line 14. `phpantom.navigate` answered `opened: true`; the file opened in a new tab in A, attached to A's PHPantom, and a window shot shows the cursor on line 14 (`class User extends Model`). A target outside the workspace answered `outside-workspace`. |
| 18 | Code actions and quick fixes | Pass | On `Collection`: `Import ...` actions (including `Illuminate\Support\Collection`) and `Convert $collection to instance variable`; `codeAction/resolve` returns the `use` edit. |
| 19 | Formatting | Pass | `Format.php` came back as one whole-file edit in PSR style, 0.78 s. |
| 20 | Rename within the file | Pass | `prepareRename` on `$message` gives its range; `rename` to `$msg` edits both uses in the same file. |
| 21 | 1 MB file through the worker | Pass | `Big.php` opened in 18 chunks in 2.28 s. Hover 0.13 s, semantic tokens 0.82 s (58,200 integers), inlay hints for 200 lines 0.13 s (none apply in this file). Twenty one-character changes were all accepted, the slowest 0.14 s. A version gap answered `resync: true`. Typing feel is on the hand checklist. |
| 22 | Outside change with no unsaved edits | Partly run | A shell write added a method to B's open `Demo.php`. While another workspace was shown, nothing reached the editor for 30 s. As soon as B was shown, PHPantom's outline listed the new method (0.8 s). Not checked: whether Orca's Source view behaves the same for a background workspace, and whether the wait is Orca's or the plugin's. Save and dirty state are on the hand checklist. |
| 23 | `restartAll()`, the function behind `PHPantom: Restart language servers`, called through the temporary handler | Pass | Answered `stopped 2 server(s)`. The open editor in B attached again within about 1 s, with one new `phpantom_lsp`. |
| 24 | `orca plugin restart local.phpantom` | Partly met (one sample, 7.7 s) | The old `phpantom_lsp` was gone 0.5 s later. The worker came back with a new session, and the open editor in B attached again 7.7 s after the restart. One sample only, and `orca plugin restart` only stops the worker: the describe request used to watch it is what started it again. Running the palette command is on the hand checklist. |
| 25 | Status bar | Pass for idle and ready | Before any PHP file: `PHPantom`, tooltip `PHPantom: no PHP files open`. Then `PHPantom` with a check icon, tooltip `PHPantom 1.1.0 (from PATH), ready`, also seen in a status bar shot of the installed copy. `starting` and `indexing` were not caught: this project indexes in under a second. |
| 26 | Binary found with no setup | Pass | `Using PHPantom 1.1.0 (from PATH): /opt/homebrew/bin/phpantom_lsp`. |
| 27 | Download when no binary is installed, tooltip says `downloaded` | Not run | Homebrew's `phpantom_lsp` is on this machine and is also one of the folders the plugin always checks, so the download cannot be reached without removing it. Covered by unit tests. |
| 28 | Remote (SSH) workspace shows the remote note | Not run | This Orca has no SSH host (`orca host list` lists only `local`). Covered by the unit test `a remote focused workspace is never attached`. |
| 29 | One PHPantom per project root, stopped when idle | Partly run | One process per root was seen (A and B each got their own). The 10-minute idle stop was not waited for. Covered by unit tests. |

## Using it with Autocomplete

Autocomplete was not installed for this run. Its manifest (at `da5a680`) declares an editor
`code-php` for `.php` with `priority: "default"` and `frame: "isolated"`. A throwaway stand-in plugin
with exactly that editor was loaded next to PHPantom in an earlier pass of this smoke, on commit `af297b7`
(with PHPantom installed and the stand-in dev-loaded after it). The stand-in opened new `.php` files and
also new `.blade.php` files, and tabs already open as PHP files switched to it. Two stand-in ids
were tried, but both sort before `noppu-labs.phpantom`, so the rule Orca uses to pick between two
plugins (load order, development over installed, or plugin id) is still unknown.

A tab's view toggle sits at the top right of the editor, beside Source (`<>`), with one icon for
each editor that can open the file. Item 11 of the hand checklist covers the real plugin.

## Owner's hand checklist (not run)

Use any Laravel project in a local workspace with the plugin installed. Each step takes about a
minute.

1. Typing. Open a PHP file and type a few lines quickly, including `$this->`. No characters go
   missing, the completion list appears, and typing never waits on it.
2. Large file. Make a 1 MB PHP file (for example
   `python3 -c "print('<?php\nclass Big {\n' + ''.join(f'public function m{i}(): int {{ return {i}; }}\n' for i in range(22000)) + '}')" > app/Big.php`),
   open it and type in the middle. It stays as responsive as a small file.
3. Save and dirty state. Edit a file: the tab shows unsaved. Press Cmd+S: it shows saved, and
   `git diff` has the change.
4. Outside change, clean tab. With no unsaved edits, run `echo "// from the terminal" >> <file>` in
   a terminal. The line appears in the open editor.
5. Agent write during unsaved edits. Change line 5 of a file and do not save. In a terminal, run
   `sed -i '' '5s/.*/\/\/ written by an agent/' <file>`. The editor keeps both versions of line 5
   between conflict markers, shows a note, and the tab stays unsaved. Nothing is lost.
6. Undo after that. Press Cmd+Z a few times. It steps back through the merge and then through
   your own edits, and Cmd+Shift+Z redoes them.
7. Auto-import. In a class, type `new Collec` and pick `Illuminate\Support\Collection`. The `use`
   line is added at the top.
8. Hover and signature help. Hover a method call: its signature shows. Type `(` after a method
   name: the parameter hint shows.
9. Cmd-click. Cmd-click `Authenticatable` in `class User extends Authenticatable` in
   `app/Models/User.php`. The vendor file opens in a new tab with
   the cursor on the class.
10. Rename, quick fix, format. F2 on a local variable renames it in the file. Cmd+. on an unknown
    class offers imports. Format Document reformats the file.
11. Autocomplete. With Autocomplete installed and enabled, open a `.php` and a `.blade.php` file you
    have not opened before. Note which editor opens each one, then use the view toggle at the top
    right of the tab to switch to PHPantom and back. Write down what you saw in the README.
12. Restart. Run `PHPantom: Restart language servers` from the command palette. The open editor
    keeps working within a few seconds. Click the status bar item: it shows the server and the open
    files.
13. Outside change in a background workspace. Open a PHP file in one workspace, then switch to
    another workspace. In a terminal, run `echo "// from the terminal" >> <file>`, wait ten
    seconds and switch back. Note whether the line was already there or appeared only on return.
    Do the same with the file switched to Source in the view toggle, and compare.
