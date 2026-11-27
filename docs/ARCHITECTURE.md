# Architecture

orca-phpantom is an Orca plugin that runs as a trusted worker. It opens no listening socket. Orca starts its worker and loads its editor page in each PHP or Blade tab, and the worker starts one `phpantom_lsp` child per Composer root and talks to it over stdio. This page covers the actors, what each of them does, and every interface the plugin exposes. [SECURITY_ASSESSMENT.md](SECURITY_ASSESSMENT.md) covers what can go wrong.

The file-by-file layout is in [CONTRIBUTING.md](CONTRIBUTING.md#layout).

## Actors

| Actor            | What it is                                                                                                         | What it can do to the others                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| User             | The person editing PHP in Orca                                                                                     | Opens and edits files, sets the two settings, runs the two commands, clicks the status bar item                                                |
| Orca host        | The Orca desktop app                                                                                               | Installs and starts the plugin, relays requests and events between editor frames and the worker, lists workspaces, opens tabs, saves documents |
| Worker           | `src/main.ts` and what it wires: the router, the binary lookup, the PHPantom servers                               | Walks local workspaces and reads files, downloads PHPantom, starts and stops PHPantom processes, posts events to editor frames                 |
| Editor frame     | One isolated frame per tab, loading `editor/pages/php.html` or `blade.html` and the Monaco bundle in `editor/dist` | Edits the tab's document through Orca's document session, sends `phpantom.*` requests to the worker                                            |
| PHPantom process | `phpantom_lsp --stdio`, one per Composer root, run with the user's rights                                          | Reads the project, runs PHPStan, PHPCS, PHPMD or Mago when it finds them, answers LSP requests                                                 |
| GitHub releases  | `github.com/PHPantom-dev/phpantom_lsp/releases`, used only when no PHPantom is installed and `allowDownload` is on | Supplies the PHPantom archive                                                                                                                  |

## Actions

### Opening a file

A custom editor never learns its file's path. The frame reads the document from Orca's document session and sends its text to the worker in `phpantom.open` chunks of up to 56 KiB, under Orca's 64 KiB request limit, with the workspace context Orca gave the frame. The router (`src/controllers/router.ts`) then:

1. Finds the workspace. A remote workspace or a WSL share gets the answer `remote`, and the tab keeps highlighting only.
2. Finds the file (`src/services/locate/locate.ts`). It tries files the user is navigating to, then files attached before, then walks the focused workspace and the other local ones breadth first, for up to 3 seconds and 80,000 entries, looking for a file of the right type with exactly this text. Without an exact match, the file sharing most of its lines wins, if it is clearly ahead. No match or a tie answers `single-file`.
3. Picks the nearest folder with a `composer.json` between the file and the workspace root (`src/services/locate/workspaces.ts`). A file under a project's `vendor/` belongs to that project.
4. Starts PHPantom for that root if none runs, and sends `textDocument/didOpen`. Two tabs on one file share one open.
5. Answers `ready` with PHPantom's capabilities, and the frame registers only the Monaco features PHPantom offers.

### Typing

The frame batches Monaco's changes and sends them in `phpantom.change` at most 400 ms after the first one, with a version and the expected length. The worker applies them to its copy (`src/services/lsp/mirror.ts`). When the version skips or the length differs, it answers `resync` and the frame opens the document again. Otherwise it forwards the changes as `textDocument/didChange`, or the whole text when another tab on the same file moved PHPantom's copy.

### A request

Completion, hover, formatting and the other features go out as `phpantom.request` with an LSP method and params. The worker first makes sure PHPantom holds this tab's text, sets the document URI, and forwards the request. An answer over 900 KiB by Orca's measure (`src/utils/size.ts`) is cut: completion and location lists keep their leading items, semantic tokens keep whole tokens, and anything else answers `too_large`. The frame drops an answer that edits the text (formatting, rename, a resolved code action) if the text moved while it waited, and refuses a rename or fix whose edits reach other files.

### Navigation and peek

Going to a definition in another file sends `phpantom.navigate`. The worker accepts only a `file:` URI that names an existing file inside a local workspace, remembers the target range for 30 seconds, and asks Orca to open the file. The new tab attaches as above and gets the range back as `reveal`. A tab already showing that file gets a `phpantom.reveal` event.

Previews (peek, Cmd-hover) send `phpantom.peek` with up to 25 `file:` URIs. The worker reads them and returns at most 600 KiB of text, and the frame shows each file in a read-only model.

### Idle release

Each frame sends `phpantom.ping` every 20 seconds. Every 15 seconds the worker releases a document it has not heard from in 3 minutes, as a close would. If that check runs late (the computer slept), it releases nothing that round. A PHPantom with no documents left stops after 10 minutes.

### Restart

`PHPantom: Restart language servers` stops every PHPantom, forgets the binary, and posts `restarting` to each open tab, which then attaches again. When a PHPantom exits on its own, its tabs get an `error` status and attach again later. After a root's fourth crash within 5 minutes, opening a file there answers an error until the oldest of those crashes is 5 minutes old or the command runs.

### Binary lookup and download

Before the first server starts, `src/services/binary/resolve.ts` takes the first `phpantom_lsp` that answers `--version`:

1. The `phpantomPath` setting. If that is set and doesn't work, the lookup stops with an error.
2. `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` and `~/.cargo/bin` (`%USERPROFILE%\.cargo\bin` on Windows), at version 1.1.0 or newer.
3. A copy in the cache folder with a `verified` marker beside it.
4. With `allowDownload` on, the pinned 1.1.0 asset for this platform. Its SHA-256 must match `ASSETS` in `src/services/binary/release.ts` before extraction. Only the `phpantom_lsp` member is taken from the archive, in memory, and written to a fixed path.

After a download the plugin writes a global `.phpantom.toml` that turns on full colouring, unless one exists. A failed lookup is retried after 2 minutes, on a settings change, or on restart.

## External interfaces

### Manifest contributions

`orca-plugin.json` declares the `settings:own`, `workspace:read` and `workspace:write` capabilities, two custom editors (`php` for `.php`, `.module`, `.install`, `.theme`, `.profile`, `.inc` and `.engine`; `blade` for `.blade.php`), both with an isolated frame, two settings, two commands and one status bar item.

### Panel requests and events

Declared in `src/protocol.ts`. Every request but `open` and `close` carries the worker's `session`. For a stale session or a document the worker no longer holds, `change`, `request` and `ping` answer `detached`, `navigate` answers `failed`, and `peek` returns no files.

| Request             | Input                                     | Output                                                              |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `phpantom.open`     | Document id, language, workspace, a chunk | `ready`, `pending`, `single-file`, `remote` or `error`              |
| `phpantom.change`   | Document id, version, LSP changes, length | `ok`, `detached` or `resync`                                        |
| `phpantom.request`  | Document id, LSP method and params        | The result (with `truncated` when cut), `detached` or `error`       |
| `phpantom.close`    | Document id                               | `ok`                                                                |
| `phpantom.navigate` | Document id, a URI and a range            | `opened`, or not with `outside-workspace`, `not-a-file` or `failed` |
| `phpantom.peek`     | Document id, URIs                         | The files read, and how many were left out                          |
| `phpantom.ping`     | Document id                               | `ok` or `detached`                                                  |

| Event                  | Payload                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `phpantom.diagnostics` | A document's diagnostics, and how many were left out (`truncated`) |
| `phpantom.status`      | A document's state: `restarting`, `stopped` or `error`             |
| `phpantom.refresh`     | Which features to ask for again, when PHPantom asks for that       |
| `phpantom.reveal`      | A range to show in a document                                      |

Posts go through `src/services/outbox.ts`, which keeps them under Orca's 200 posts per 10 seconds and 256 KiB each. A newer post of the same kind for the same document replaces a queued one. A diagnostics list too big for one post keeps its most severe entries, and a long status message is shortened.

### Settings, commands and the status bar

- `phpantomPath` (string): full path to `phpantom_lsp`. `allowDownload` (boolean, on by default): whether the plugin may download it. A change clears the cached lookup.
- `phpantom.status` lists the binary, each server's state and the open files. `phpantom.restart` is described above.
- The `phpantom` status bar item shows idle, downloading, starting, indexing with a percentage, ready, or error, at most once a second. Its tooltip names the version and where the binary came from.

### LSP over stdio

The worker starts `phpantom_lsp --stdio` in the Composer root and speaks JSON-RPC 2.0 with `Content-Length` framing (`src/services/lsp/jsonrpc.ts`). It sends `initialize` with the capabilities in `src/services/lsp/capabilities.ts` (UTF-16 positions, pushed diagnostics, `applyEdit` off) and waits up to 60 seconds for the answer. It answers `workspace/configuration` with `null` for each item, `workspace/applyEdit` with `applied: false`, and turns the refresh requests into `phpantom.refresh`. It reads `publishDiagnostics`, `$/progress` and error or warning `window/logMessage`. To stop a server it sends `shutdown` and `exit`, closes stdin, and kills the process if it is still there 2 seconds later.

### The download

With `allowDownload` on and no usable binary, the worker fetches `https://github.com/PHPantom-dev/phpantom_lsp/releases/download/1.1.0/<asset>`, following GitHub's redirect. The six assets (macOS, Linux and Windows on x64 and arm64) and their SHA-256 values are pinned in `src/services/binary/release.ts`. The request carries nothing about the user.

### Files the worker writes

- The cache folder: `~/Library/Caches/noppu-labs.phpantom` on macOS, `$XDG_CACHE_HOME/noppu-labs.phpantom` (or `~/.cache/noppu-labs.phpantom`) on Linux, `%LOCALAPPDATA%\noppu-labs.phpantom\cache` on Windows. It holds `1.1.0/<platform>-<arch>/` with the binary and its `verified` marker.
- After a download only: `~/.config/phpantom_lsp/.phpantom.toml` (under `$XDG_CONFIG_HOME` if set, `%APPDATA%\phpantom_lsp\.phpantom.toml` on Windows), created only when no file is there.

The worker writes nothing in workspaces. Edits reach disk through Orca's document session when the user saves.

### Logs

The worker writes to Orca's plugin log: which binary it uses, server starts and stops, released documents, PHPantom's error and warning log messages, and its stderr tail when it exits.
